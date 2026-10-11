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
