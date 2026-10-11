import { makeRef } from "@friend/protocol";
import type { Config } from "../config";
import { freshToken, MusicSecrets, MusicTokens, OAuthStates, pkcePair, RefreshRejected } from "./oauth";
import type { MusicSource, SourceStatus, SourceTrack } from "./source";

const AUTH = "https://secure.soundcloud.com";
const API = "https://api.soundcloud.com";
const HOSTS = new Set(["secure.soundcloud.com", "api.soundcloud.com"]);
const ID = /^[0-9]{1,20}$/;
const FALLBACK_TTL_S = 3600;
const MAX_HOPS = 3;

/** Only SoundCloud's own https addresses are ever fetched or handed to a player. */
export function isSoundCloudAddress(address: string): boolean {
  try {
    const u = new URL(address);
    return u.protocol === "https:" && /(^|\.)(soundcloud\.com|sndcdn\.com|soundcloud\.cloud)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export interface SoundCloudHubDeps {
  config: () => Pick<Config, "music">;
  tokens: MusicTokens;
  secrets: MusicSecrets;
  fetch?: typeof fetch;
  clock?: () => number;
  publicBase: () => string;
  states?: OAuthStates;
  /** How long to wait for SoundCloud to answer before giving up (default 8 seconds). */
  requestTimeoutMs?: number;
}

interface ApiTrack {
  id?: number;
  title?: string;
  user?: { username?: string };
  duration?: number;
  access?: string;
}

const RECONNECT = "Reconnect SoundCloud in Plugins, SoundCloud.";
const CONNECT = "Connect your SoundCloud account in Plugins, SoundCloud.";

/**
 * The owner's own SoundCloud account as a music source: OAuth with PKCE (SoundCloud also wants the app's secret, kept write-only in
 * its own file), a login kept fresh, search, playlists and tracks. A track is played from a stream address that SoundCloud gives
 * for a moment; that address is checked to be SoundCloud's own and is never stored.
 */
export class SoundCloudHub implements MusicSource {
  readonly id = "soundcloud" as const;
  private states: OAuthStates;

  constructor(private d: SoundCloudHubDeps) {
    this.states = d.states ?? new OAuthStates(d.clock);
  }

  private get now(): () => number {
    return this.d.clock ?? Date.now;
  }

  private cfg() {
    return this.d.config().music.soundcloud;
  }

  redirectUri(): string {
    return `${this.d.publicBase().replace(/\/+$/, "")}/api/music/oauth/callback`;
  }

  /** Where to send the owner to allow Friend, or null when the client id or secret is missing. */
  connectUrl(): string | null {
    const clientId = this.cfg().clientId;
    if (!clientId || !this.d.secrets.has("soundcloud")) return null;
    const { verifier, challenge } = pkcePair();
    const state = this.states.issue("soundcloud", verifier);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: this.redirectUri(), state, code_challenge_method: "S256", code_challenge: challenge });
    return `${AUTH}/authorize?${q.toString()}`;
  }

  status(): SourceStatus {
    const c = this.cfg();
    if (!c.installed || !c.enabled) return { connected: false, needs: "Install and switch on SoundCloud in Plugins.", account: null };
    if (!c.clientId) return { connected: false, needs: "Add your SoundCloud client id in Plugins, SoundCloud.", account: null };
    if (!this.d.secrets.has("soundcloud")) return { connected: false, needs: "Add your SoundCloud client secret in Plugins, SoundCloud.", account: null };
    const login = this.d.tokens.load("soundcloud");
    if (!login) return { connected: false, needs: CONNECT, account: null };
    if (this.d.tokens.needsReconnect("soundcloud")) return { connected: false, needs: RECONNECT, account: login.account };
    return { connected: true, needs: null, account: login.account };
  }

  disconnect(): void {
    this.d.tokens.forget("soundcloud");
  }

  private async call(url: string, init?: RequestInit): Promise<Response> {
    if (!HOSTS.has(new URL(url).host)) throw new Error("Friend only talks to SoundCloud's own addresses.");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.d.requestTimeoutMs ?? 8000);
    try {
      return await (this.d.fetch ?? fetch)(url, { ...init, signal: ctl.signal });
    } catch {
      throw new Error("Friend could not reach SoundCloud right now.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async tokenRequest(body: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
    const res = await this.call(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ ...body, client_id: this.cfg().clientId, client_secret: this.d.secrets.get("soundcloud") }).toString(),
    });
    let j: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown } = {};
    try {
      j = (await res.json()) as typeof j;
    } catch {
      /* handled below */
    }
    if (res.status === 400 || res.status === 401) throw new RefreshRejected("SoundCloud did not accept the sign-in.");
    if (!res.ok || typeof j.access_token !== "string") throw new Error("SoundCloud did not accept the sign-in.");
    const seconds = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : FALLBACK_TTL_S;
    return { accessToken: j.access_token, ...(typeof j.refresh_token === "string" ? { refreshToken: j.refresh_token } : {}), expiresAt: this.now() + seconds * 1000 };
  }

  /** Finishes a login from SoundCloud's return. Only a state Friend issued, once, within ten minutes, is accepted. */
  async completeLogin(params: Record<string, string | undefined>): Promise<{ ok: true } | { ok: false; error: string }> {
    const pending = this.states.take(params.state ?? "");
    if (!pending || pending.source !== "soundcloud") return { ok: false, error: "That sign-in link is not valid or has run out. Start again from Friend." };
    if (params.error) return { ok: false, error: params.error === "access_denied" ? "You did not allow Friend to use your SoundCloud account." : "SoundCloud did not complete the sign-in." };
    if (!params.code) return { ok: false, error: "SoundCloud did not send a sign-in code. Start again from Friend." };
    try {
      const t = await this.tokenRequest({ grant_type: "authorization_code", code: params.code, redirect_uri: this.redirectUri(), code_verifier: pending.verifier });
      if (!t.refreshToken) return { ok: false, error: "SoundCloud did not complete the sign-in." };
      const me = await this.call(`${API}/me`, { headers: { authorization: `OAuth ${t.accessToken}` } });
      const j = (me.ok ? await me.json().catch(() => null) : null) as { username?: string } | null;
      this.d.tokens.save("soundcloud", { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, account: (j?.username || "SoundCloud").slice(0, 80), premium: null });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error && /SoundCloud|Friend/.test(e.message) ? e.message : "SoundCloud did not complete the sign-in." };
    }
  }

  /** A good access token, renewed when needed, or null when the owner must connect (again). */
  async accessToken(): Promise<string | null> {
    return freshToken("soundcloud", this.d.tokens, (rt) => this.tokenRequest({ grant_type: "refresh_token", refresh_token: rt }), this.now);
  }

  /** `forbiddenIsNull`: for one track, a 403 means this account may not play it (blocked, region, plan), not that the login is bad. */
  private async api<T>(path: string, retry = true, forbiddenIsNull = false): Promise<T | null> {
    const token = await this.accessToken();
    if (!token) {
      if (this.d.tokens.needsReconnect("soundcloud")) throw new Error(RECONNECT);
      throw new Error(this.d.tokens.load("soundcloud") ? "SoundCloud could not renew the sign-in just now. Try again in a minute." : CONNECT);
    }
    const res = await this.call(`${API}${path}`, { headers: { authorization: `OAuth ${token}`, accept: "application/json" } });
    if (res.status === 401 && retry) {
      const login = this.d.tokens.load("soundcloud");
      if (login) this.d.tokens.save("soundcloud", { ...login, expiresAt: 0 });
      return this.api<T>(path, false, forbiddenIsNull);
    }
    if (res.status === 403 && forbiddenIsNull) return null;
    if (res.status === 429) throw new Error("SoundCloud is asking Friend to slow down. Try again in a minute.");
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new Error("SoundCloud refused that request. Reconnect SoundCloud in Plugins, SoundCloud.");
    if (!res.ok) throw new Error("SoundCloud did not answer properly right now.");
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error("SoundCloud did not answer properly right now.");
    }
  }

  private of(t: ApiTrack): SourceTrack | null {
    if (typeof t.id !== "number" || !ID.test(String(t.id)) || t.access !== "playable") return null;
    return {
      ref: makeRef("soundcloud", String(t.id)),
      source: "soundcloud",
      title: String(t.title ?? "").slice(0, 200),
      artist: String(t.user?.username ?? "").slice(0, 200),
      album: "",
      durationSec: typeof t.duration === "number" ? Math.round(t.duration / 1000) : null,
    };
  }

  async search(query: string, limit: number): Promise<SourceTrack[]> {
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    const j = await this.api<ApiTrack[]>(`/tracks?${new URLSearchParams({ q: query.slice(0, 200), limit: String(n), access: "playable" })}`);
    return (Array.isArray(j) ? j : []).flatMap((t) => this.of(t) ?? []);
  }

  async playlists(limit: number): Promise<{ id: string; name: string; tracks: number }[]> {
    const j = await this.api<{ id?: number; title?: string; track_count?: number }[]>(`/me/playlists?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`);
    return (Array.isArray(j) ? j : []).flatMap((p) => (typeof p.id === "number" && ID.test(String(p.id)) ? [{ id: String(p.id), name: String(p.title ?? "").slice(0, 200), tracks: p.track_count ?? 0 }] : []));
  }

  async tracksOf(playlistId: string, limit: number): Promise<SourceTrack[]> {
    if (!ID.test(playlistId)) throw new Error("That is not a SoundCloud playlist.");
    const j = await this.api<ApiTrack[]>(`/playlists/${playlistId}/tracks?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`);
    return (Array.isArray(j) ? j : []).flatMap((t) => this.of(t) ?? []);
  }

  async track(id: string): Promise<SourceTrack | null> {
    if (!ID.test(id)) return null;
    const j = await this.api<ApiTrack>(`/tracks/${id}`, true, true);
    return j ? this.of(j) : null;
  }

  /** SoundCloud's temporary https address of the track's audio, checked to be SoundCloud's own. Never stored, never logged. */
  async streamOf(id: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    if (!ID.test(id)) return { ok: false, error: "That is not a SoundCloud track." };
    try {
      const j = await this.api<{ http_mp3_128_url?: unknown }>(`/tracks/${id}/streams`, true, true);
      if (!j) return { ok: false, error: "SoundCloud does not let this account play that track." };
      const url = j.http_mp3_128_url;
      if (typeof url !== "string" || !isSoundCloudAddress(url)) return { ok: false, error: "SoundCloud gave no playable address for that track." };
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "SoundCloud did not answer properly right now." };
    }
  }

  /** Fetches the audio from a vetted address, following at most three redirects and only to SoundCloud's own https addresses. */
  async fetchAudio(address: string, range?: string, signal?: AbortSignal): Promise<{ ok: true; res: Response } | { ok: false; error: string }> {
    let next = address;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!isSoundCloudAddress(next)) return { ok: false, error: "SoundCloud sent the audio somewhere Friend will not follow." };
      let res: Response;
      try {
        // a CDN that never answers must not hold the request open: the headers have eight seconds, the body then streams freely
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.d.requestTimeoutMs ?? 8000);
        const stop = signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal;
        try {
          res = await (this.d.fetch ?? fetch)(next, { redirect: "manual", headers: range ? { range } : {}, signal: stop });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return { ok: false, error: "Friend could not reach SoundCloud right now." };
      }
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {});
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, error: "SoundCloud did not answer properly right now." };
        try {
          next = new URL(loc, next).toString();
        } catch {
          return { ok: false, error: "SoundCloud did not answer properly right now." };
        }
        continue;
      }
      if (!res.ok && res.status !== 206) return { ok: false, error: "SoundCloud did not play that track right now." };
      return { ok: true, res };
    }
    return { ok: false, error: "SoundCloud sent the audio around too many times." };
  }
}
