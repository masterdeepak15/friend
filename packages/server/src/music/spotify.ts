import { makeRef } from "@friend/protocol";
import type { Config } from "../config";
import { freshToken, MusicTokens, OAuthStates, pkcePair, RefreshRejected } from "./oauth";
import type { MusicSource, SourceStatus, SourceTrack } from "./source";

const AUTH = "https://accounts.spotify.com";
const API = "https://api.spotify.com";
const HOSTS = new Set(["accounts.spotify.com", "api.spotify.com"]);
const SCOPES = "user-read-private user-read-email streaming user-modify-playback-state user-read-playback-state playlist-read-private";
const PLAYLIST_ID = /^[A-Za-z0-9]{1,64}$/;
const TRACK_ID = /^[A-Za-z0-9]{1,64}$/;
const FALLBACK_TTL_S = 3600;

export interface SpotifyHubDeps {
  config: () => Pick<Config, "music">;
  tokens: MusicTokens;
  fetch?: typeof fetch;
  clock?: () => number;
  /** The address people reach Friend at: the public address, or http://127.0.0.1:<port> when there is none. */
  publicBase: () => string;
  states?: OAuthStates;
}

interface ApiTrack {
  id?: string;
  name?: string;
  artists?: { name?: string }[];
  album?: { name?: string };
  duration_ms?: number;
}

const RECONNECT = "Reconnect Spotify in Plugins, Spotify.";

/**
 * The owner's own Spotify account as a music source: signing in with OAuth (PKCE, no secret), keeping the login fresh, and
 * reading search results, playlists and tracks. Playing happens on the screen, in Spotify's own web player.
 */
export class SpotifyHub implements MusicSource {
  readonly id = "spotify" as const;
  private states: OAuthStates;

  constructor(private d: SpotifyHubDeps) {
    this.states = d.states ?? new OAuthStates(d.clock);
  }

  private get now(): () => number {
    return this.d.clock ?? Date.now;
  }

  private cfg() {
    return this.d.config().music.spotify;
  }

  /** The return address the owner registers in their Spotify app. */
  redirectUri(): string {
    return `${this.d.publicBase().replace(/\/+$/, "")}/api/music/oauth/callback`;
  }

  /** Where to send the owner to allow Friend, or null when there is no client id yet. */
  connectUrl(): string | null {
    const clientId = this.cfg().clientId;
    if (!clientId) return null;
    const { verifier, challenge } = pkcePair();
    const state = this.states.issue("spotify", verifier);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: this.redirectUri(), scope: SCOPES, state, code_challenge_method: "S256", code_challenge: challenge });
    return `${AUTH}/authorize?${q.toString()}`;
  }

  status(): SourceStatus {
    const c = this.cfg();
    if (!c.installed || !c.enabled) return { connected: false, needs: "Install and switch on Spotify in Plugins.", account: null };
    if (!c.clientId) return { connected: false, needs: "Add your Spotify client id in Plugins, Spotify.", account: null };
    const login = this.d.tokens.load("spotify");
    if (!login) return { connected: false, needs: "Connect your Spotify account in Plugins, Spotify.", account: null };
    if (this.d.tokens.needsReconnect("spotify")) return { connected: false, needs: RECONNECT, account: login.account };
    return { connected: true, needs: login.premium === false ? "Spotify Premium is needed to play (searching works)." : null, account: login.account, canPlay: login.premium !== false };
  }

  disconnect(): void {
    this.d.tokens.forget("spotify");
  }

  private async call(url: string, init?: RequestInit): Promise<Response> {
    if (!HOSTS.has(new URL(url).host)) throw new Error("Friend only talks to Spotify's own addresses.");
    try {
      return await (this.d.fetch ?? fetch)(url, init);
    } catch {
      throw new Error("Friend could not reach Spotify right now.");
    }
  }

  private async tokenRequest(body: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
    const res = await this.call(`${AUTH}/api/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: this.cfg().clientId }).toString() });
    let j: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } = {};
    try {
      j = (await res.json()) as typeof j;
    } catch {
      /* handled below */
    }
    if (res.status === 400 || res.status === 401) throw new RefreshRejected("Spotify did not accept the sign-in.");
    if (!res.ok || typeof j.access_token !== "string") throw new Error("Spotify did not accept the sign-in.");
    const seconds = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : FALLBACK_TTL_S;
    return { accessToken: j.access_token, ...(typeof j.refresh_token === "string" ? { refreshToken: j.refresh_token } : {}), expiresAt: this.now() + seconds * 1000 };
  }

  /** Finishes a login from Spotify's return. Only a state Friend issued, once, within ten minutes, is accepted. */
  async completeLogin(params: Record<string, string | undefined>): Promise<{ ok: true } | { ok: false; error: string }> {
    const pending = this.states.take(params.state ?? "");
    if (!pending || pending.source !== "spotify") return { ok: false, error: "That sign-in link is not valid or has run out. Start again from Friend." };
    if (params.error) return { ok: false, error: params.error === "access_denied" ? "You did not allow Friend to use your Spotify account." : "Spotify did not complete the sign-in." };
    if (!params.code) return { ok: false, error: "Spotify did not send a sign-in code. Start again from Friend." };
    try {
      const t = await this.tokenRequest({ grant_type: "authorization_code", code: params.code, redirect_uri: this.redirectUri(), code_verifier: pending.verifier });
      if (!t.refreshToken) return { ok: false, error: "Spotify did not complete the sign-in." };
      const me = await this.call(`${API}/v1/me`, { headers: { authorization: `Bearer ${t.accessToken}` } });
      const j = (me.ok ? await me.json().catch(() => null) : null) as { display_name?: string; id?: string; product?: string } | null;
      this.d.tokens.save("spotify", { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, account: (j?.display_name || j?.id || "Spotify").slice(0, 80), premium: j?.product ? j.product === "premium" : null });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error && /Spotify|Friend/.test(e.message) ? e.message : "Spotify did not complete the sign-in." };
    }
  }

  /** A good access token, renewed when needed, or null when the owner must connect (again). */
  async accessToken(): Promise<string | null> {
    return freshToken("spotify", this.d.tokens, (rt) => this.tokenRequest({ grant_type: "refresh_token", refresh_token: rt }), this.now);
  }

  private async api<T>(path: string, retry = true): Promise<T | null> {
    const token = await this.accessToken();
    if (!token) {
      if (this.d.tokens.needsReconnect("spotify")) throw new Error(RECONNECT);
      throw new Error(this.d.tokens.load("spotify") ? "Spotify could not renew the sign-in just now. Try again in a minute." : "Connect your Spotify account in Plugins, Spotify.");
    }
    const res = await this.call(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401 && retry) {
      const login = this.d.tokens.load("spotify");
      if (login) this.d.tokens.save("spotify", { ...login, expiresAt: 0 });
      return this.api<T>(path, false);
    }
    if (res.status === 429) throw new Error("Spotify is asking Friend to slow down. Try again in a minute.");
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new Error("Spotify refused that request. Reconnect Spotify in Plugins, Spotify.");
    if (!res.ok) throw new Error("Spotify did not answer properly right now.");
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("Spotify did not answer properly right now.");
    }
  }

  /** A call to the player endpoints (which device plays, what plays, pause and so on). One renewal on a revoked token, one sentence on any failure. */
  private async player(method: "GET" | "PUT" | "POST", path: string, body?: unknown, retry = true): Promise<{ status: number; json: unknown }> {
    const token = await this.accessToken();
    if (!token) throw new Error(this.d.tokens.needsReconnect("spotify") ? RECONNECT : "Connect your Spotify account in Plugins, Spotify.");
    const res = await this.call(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retry) {
      const login = this.d.tokens.load("spotify");
      if (login) this.d.tokens.save("spotify", { ...login, expiresAt: 0 });
      return this.player(method, path, body, false);
    }
    if (res.status === 429) throw new Error("Spotify is asking Friend to slow down. Try again in a minute.");
    if (res.status === 403) throw new Error("Spotify Premium is needed to control playback.");
    if (res.status === 404) throw new Error("Spotify has no active device for that. Open Spotify on the PC first.");
    if (res.status === 204) return { status: 204, json: null };
    if (!res.ok) throw new Error("Spotify did not answer properly right now.");
    if (method !== "GET") return { status: res.status, json: null };
    try {
      return { status: res.status, json: await res.json() };
    } catch {
      throw new Error("Spotify did not answer properly right now.");
    }
  }

  /** The devices Spotify knows on the owner's account (Spotify apps and any Spotify Connect player, such as one running on the PC). */
  async devices(): Promise<{ id: string; name: string; active: boolean }[]> {
    const r = await this.player("GET", "/v1/me/player/devices");
    const list = ((r.json as { devices?: { id?: string; name?: string; is_active?: boolean }[] } | null)?.devices ?? []) as { id?: string; name?: string; is_active?: boolean }[];
    return list.flatMap((d) => (d.id && d.name ? [{ id: d.id, name: d.name, active: d.is_active === true }] : []));
  }

  /** Plays these tracks on the device with that name. Says which devices exist when the name is not one of them. */
  async playOn(deviceName: string, trackIds: string[], positionMs?: number): Promise<{ ok: true; deviceId: string } | { ok: false; error: string }> {
    if (!trackIds.length || !trackIds.every((id) => TRACK_ID.test(id))) return { ok: false, error: "That is not a Spotify track." };
    try {
      const list = await this.devices();
      const want = deviceName.trim().toLowerCase();
      const device = list.find((d) => d.name.trim().toLowerCase() === want);
      if (!device) {
        return { ok: false, error: list.length ? `No Spotify device named "${deviceName.trim()}" is available. Found: ${list.map((d) => d.name).join(", ")}.` : "No Spotify device is available. Open Spotify (or a Spotify Connect player) on the PC first." };
      }
      await this.player("PUT", `/v1/me/player/play?device_id=${encodeURIComponent(device.id)}`, { uris: trackIds.map((id) => `spotify:track:${id}`), ...(positionMs !== undefined ? { position_ms: Math.max(0, Math.round(positionMs)) } : {}) });
      return { ok: true, deviceId: device.id };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Spotify did not answer properly right now." };
    }
  }

  /** Pause, resume, next, previous, seek or volume on one device. */
  async control(deviceId: string, c: { action: "pause" | "resume" | "next" | "previous" | "seek" | "volume"; ms?: number; percent?: number }): Promise<void> {
    const dev = `device_id=${encodeURIComponent(deviceId)}`;
    switch (c.action) {
      case "pause":
        await this.player("PUT", `/v1/me/player/pause?${dev}`);
        return;
      case "resume":
        await this.player("PUT", `/v1/me/player/play?${dev}`);
        return;
      case "next":
        await this.player("POST", `/v1/me/player/next?${dev}`);
        return;
      case "previous":
        await this.player("POST", `/v1/me/player/previous?${dev}`);
        return;
      case "seek":
        await this.player("PUT", `/v1/me/player/seek?position_ms=${Math.max(0, Math.round(c.ms ?? 0))}&${dev}`);
        return;
      case "volume":
        await this.player("PUT", `/v1/me/player/volume?volume_percent=${Math.min(100, Math.max(0, Math.round(c.percent ?? 0)))}&${dev}`);
    }
  }

  /** What Spotify is playing right now, or null when nothing is. */
  async playbackState(): Promise<{ playing: boolean; trackId: string | null; positionMs: number; durationMs: number; deviceName: string } | null> {
    const r = await this.player("GET", "/v1/me/player");
    const j = r.json as { is_playing?: boolean; progress_ms?: number; item?: { id?: string; duration_ms?: number } | null; device?: { name?: string } } | null;
    if (!j) return null;
    return { playing: j.is_playing === true, trackId: j.item?.id ?? null, positionMs: j.progress_ms ?? 0, durationMs: j.item?.duration_ms ?? 0, deviceName: j.device?.name ?? "" };
  }

  private of(t: ApiTrack): SourceTrack | null {
    if (!t.id || !TRACK_ID.test(t.id)) return null;
    return {
      ref: makeRef("spotify", t.id),
      source: "spotify",
      title: String(t.name ?? "").slice(0, 200),
      artist: (t.artists ?? []).map((a) => a.name ?? "").filter(Boolean).join(", ").slice(0, 200),
      album: String(t.album?.name ?? "").slice(0, 200),
      durationSec: typeof t.duration_ms === "number" ? Math.round(t.duration_ms / 1000) : null,
    };
  }

  async search(query: string, limit: number): Promise<SourceTrack[]> {
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    const j = await this.api<{ tracks?: { items?: ApiTrack[] } }>(`/v1/search?${new URLSearchParams({ q: query.slice(0, 200), type: "track", limit: String(n) })}`);
    return (j?.tracks?.items ?? []).flatMap((t) => this.of(t) ?? []);
  }

  async playlists(limit: number): Promise<{ id: string; name: string; tracks: number }[]> {
    const j = await this.api<{ items?: { id?: string; name?: string; tracks?: { total?: number } }[] }>(`/v1/me/playlists?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`);
    return (j?.items ?? []).flatMap((p) => (p.id && PLAYLIST_ID.test(p.id) ? [{ id: p.id, name: String(p.name ?? "").slice(0, 200), tracks: p.tracks?.total ?? 0 }] : []));
  }

  async tracksOf(playlistId: string, limit: number): Promise<SourceTrack[]> {
    if (!PLAYLIST_ID.test(playlistId)) throw new Error("That is not a Spotify playlist.");
    const j = await this.api<{ items?: { track?: ApiTrack | null }[] }>(`/v1/playlists/${playlistId}/tracks?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
    return (j?.items ?? []).flatMap((i) => (i.track ? (this.of(i.track) ?? []) : []));
  }

  async track(id: string): Promise<SourceTrack | null> {
    if (!TRACK_ID.test(id)) return null;
    const j = await this.api<ApiTrack>(`/v1/tracks/${id}`);
    return j ? this.of(j) : null;
  }
}
