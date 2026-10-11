import { makeRef } from "@friend/protocol";
import type { Config } from "../config";
import type { MusicSource, SourceStatus, SourceTrack } from "./source";

const API = "https://api.audius.co";
const APP_NAME = "Friend";
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_HOPS = 3;

/**
 * An address Audius's own API redirected a stream to. Audius spreads its audio over many content nodes run by other people, so a fixed
 * list of hosts is impossible; what is checked instead is that it is a plain https address of a public name (no address numbers,
 * no local names, no login, no odd port) with the stream path, so Friend can never be sent to something on the owner's own network.
 */
export function isAudiusAddress(address: string): boolean {
  try {
    const u = new URL(address);
    if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || h.startsWith("[") || /^[0-9.]+$/.test(h) || h.includes(":")) return false;
    if (h === "localhost" || /\.(local|localhost|internal|lan|home|home\.arpa|corp|intranet)$/.test(h)) return false;
    return u.pathname.startsWith("/tracks/cidstream/");
  } catch {
    return false;
  }
}

export interface AudiusHubDeps {
  config: () => Pick<Config, "music">;
  fetch?: typeof fetch;
  /** How long to wait for Audius to answer before giving up (default 8 seconds). */
  requestTimeoutMs?: number;
}

interface ApiTrack {
  id?: string;
  title?: string;
  user?: { name?: string };
  duration?: number;
  is_streamable?: boolean;
  stream_conditions?: unknown;
}

/**
 * Audius (an open music service) as a music source. Its public catalog needs no account, no key and no payment, so there is nothing
 * to sign in to: the owner installs it and switches it on. Playing is a stream address that Audius hands out for a moment.
 */
export class AudiusHub implements MusicSource {
  readonly id = "audius" as const;

  constructor(private d: AudiusHubDeps) {}

  status(): SourceStatus {
    const c = this.d.config().music.audius;
    if (!c.installed || !c.enabled) return { connected: false, needs: "Install and switch on Audius in Plugins.", account: null };
    return { connected: true, needs: null, account: null };
  }

  private async call(url: string, init?: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.d.requestTimeoutMs ?? 8000);
    try {
      return await (this.d.fetch ?? fetch)(url, { ...init, signal: ctl.signal });
    } catch {
      throw new Error("Friend could not reach Audius right now.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async api<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
    const res = await this.call(`${API}${path}?${new URLSearchParams({ ...params, app_name: APP_NAME })}`, { headers: { accept: "application/json" } });
    if (res.status === 429) throw new Error("Audius is asking Friend to slow down. Try again in a minute.");
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("Audius did not answer properly right now.");
    try {
      return ((await res.json()) as { data?: T }).data ?? null;
    } catch {
      throw new Error("Audius did not answer properly right now.");
    }
  }

  private of(t: ApiTrack): SourceTrack | null {
    if (typeof t.id !== "string" || !ID.test(t.id) || t.is_streamable !== true || t.stream_conditions) return null;
    return {
      ref: makeRef("audius", t.id),
      source: "audius",
      title: String(t.title ?? "").slice(0, 200),
      artist: String(t.user?.name ?? "").slice(0, 200),
      album: "",
      durationSec: typeof t.duration === "number" ? Math.round(t.duration) : null,
    };
  }

  async search(query: string, limit: number): Promise<SourceTrack[]> {
    const n = Math.max(1, Math.min(50, Math.floor(limit)));
    const j = await this.api<ApiTrack[]>("/v1/tracks/search", { query: query.slice(0, 200), limit: String(n) });
    return (Array.isArray(j) ? j : []).flatMap((t) => this.of(t) ?? []);
  }

  async playlists(_limit?: number): Promise<{ id: string; name: string; tracks: number }[]> {
    return [];
  }

  async tracksOf(_playlistId?: string, _limit?: number): Promise<SourceTrack[]> {
    return [];
  }

  async track(id: string): Promise<SourceTrack | null> {
    if (!ID.test(id)) return null;
    const j = await this.api<ApiTrack>(`/v1/tracks/${id}`);
    return j ? this.of(j) : null;
  }

  /** The content node's address for a track, from Audius's own redirect, checked. Never stored, never logged. */
  async streamOf(id: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    if (!ID.test(id)) return { ok: false, error: "That is not an Audius track." };
    try {
      const res = await this.call(`${API}/v1/tracks/${id}/stream?${new URLSearchParams({ app_name: APP_NAME })}`, { redirect: "manual" });
      void res.body?.cancel().catch(() => {});
      if (res.status === 429) return { ok: false, error: "Audius is asking Friend to slow down. Try again in a minute." };
      if (res.status === 404) return { ok: false, error: "That Audius track cannot be played." };
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !loc) return { ok: false, error: "Audius did not answer properly right now." };
      const url = new URL(loc, API).toString();
      if (!isAudiusAddress(url)) return { ok: false, error: "Audius gave no playable address for that track." };
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Audius did not answer properly right now." };
    }
  }

  /** Fetches the audio from a checked address, following at most three redirects and only to checked addresses. */
  async fetchAudio(address: string, range?: string, signal?: AbortSignal): Promise<{ ok: true; res: Response } | { ok: false; error: string }> {
    let next = address;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (!isAudiusAddress(next)) return { ok: false, error: "Audius sent the audio somewhere Friend will not follow." };
      let res: Response;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.d.requestTimeoutMs ?? 8000);
        const stop = signal ? AbortSignal.any([ctl.signal, signal]) : ctl.signal;
        try {
          res = await (this.d.fetch ?? fetch)(next, { redirect: "manual", headers: range ? { range } : {}, signal: stop });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return { ok: false, error: "Friend could not reach Audius right now." };
      }
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {});
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, error: "Audius did not answer properly right now." };
        try {
          next = new URL(loc, next).toString();
        } catch {
          return { ok: false, error: "Audius did not answer properly right now." };
        }
        continue;
      }
      if (!res.ok && res.status !== 206) return { ok: false, error: "Audius did not play that track right now." };
      return { ok: true, res };
    }
    return { ok: false, error: "Audius sent the audio around too many times." };
  }
}
