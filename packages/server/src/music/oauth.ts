import type { MusicSourceId } from "@friend/protocol";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_TTL_MS = 10 * 60_000;
const MAX_STATES = 20;
const REFRESH_AHEAD_MS = 60_000;

const b64url = (b: Buffer): string => b.toString("base64url");

/** The S256 challenge for a verifier (RFC 7636). */
export const challengeOf = (verifier: string): string => b64url(createHash("sha256").update(verifier).digest());

/** A fresh PKCE verifier (64 characters) and its challenge. Nothing secret is shared with the service: only the challenge goes out. */
export function pkcePair(random: (n: number) => Buffer = randomBytes): { verifier: string; challenge: string } {
  const verifier = b64url(random(48));
  return { verifier, challenge: challengeOf(verifier) };
}

/** The one-time `state` values that tie a login return to a login Friend started: single use, ten minutes, at most twenty waiting. */
export class OAuthStates {
  private pending = new Map<string, { source: MusicSourceId; verifier: string; at: number }>();

  constructor(private clock: () => number = Date.now) {}

  issue(source: MusicSourceId, verifier: string): string {
    const state = b64url(randomBytes(24));
    this.pending.set(state, { source, verifier, at: this.clock() });
    while (this.pending.size > MAX_STATES) this.pending.delete(this.pending.keys().next().value as string);
    return state;
  }

  take(state: string): { source: MusicSourceId; verifier: string } | null {
    const p = typeof state === "string" ? this.pending.get(state) : undefined;
    if (!p) return null;
    this.pending.delete(state);
    return this.clock() - p.at > STATE_TTL_MS ? null : { source: p.source, verifier: p.verifier };
  }
}

export interface SavedLogin {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account: string;
  /** Whether the account can play (Spotify Premium); null when not known. */
  premium: boolean | null;
}

/** A service login kept in its own file in the data folder, readable by the owner only. Never sent to a screen and never logged. */
export class MusicTokens {
  private reconnect = new Set<MusicSourceId>();

  constructor(private dir: string) {}

  private file(source: MusicSourceId): string {
    return join(this.dir, `music-${source}.tokens.json`);
  }

  save(source: MusicSourceId, login: SavedLogin): void {
    mkdirSync(this.dir, { recursive: true });
    const file = this.file(source);
    writeFileSync(file, JSON.stringify(login), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* permission bits unsupported on this system */
    }
    this.reconnect.delete(source);
  }

  load(source: MusicSourceId): SavedLogin | null {
    const file = this.file(source);
    if (!existsSync(file)) return null;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedLogin>;
      if (typeof j.accessToken !== "string" || typeof j.refreshToken !== "string" || typeof j.expiresAt !== "number" || typeof j.account !== "string") return null;
      return { accessToken: j.accessToken, refreshToken: j.refreshToken, expiresAt: j.expiresAt, account: j.account, premium: typeof j.premium === "boolean" ? j.premium : null };
    } catch {
      return null;
    }
  }

  forget(source: MusicSourceId): void {
    rmSync(this.file(source), { force: true });
    this.reconnect.delete(source);
  }

  markReconnect(source: MusicSourceId): void {
    this.reconnect.add(source);
  }

  /** The login could not be renewed: the owner has to connect again. */
  needsReconnect(source: MusicSourceId): boolean {
    return this.reconnect.has(source);
  }
}

const refreshing = new WeakMap<MusicTokens, Map<MusicSourceId, Promise<string | null>>>();

/**
 * An access token that is good for at least another minute: the saved one, or a renewed one. Simultaneous callers share one renewal.
 * When renewing fails the source is marked "reconnect needed", nothing is retried, and this gives null until the owner connects again.
 */
export async function freshToken(
  source: MusicSourceId,
  tokens: MusicTokens,
  refresh: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }>,
  clock: () => number = Date.now,
): Promise<string | null> {
  const login = tokens.load(source);
  if (!login || tokens.needsReconnect(source)) return null;
  if (login.expiresAt - clock() > REFRESH_AHEAD_MS) return login.accessToken;
  let map = refreshing.get(tokens);
  if (!map) refreshing.set(tokens, (map = new Map()));
  const running = map.get(source);
  if (running) return running;
  const job = (async (): Promise<string | null> => {
    try {
      const next = await refresh(login.refreshToken);
      tokens.save(source, { ...login, accessToken: next.accessToken, refreshToken: next.refreshToken ?? login.refreshToken, expiresAt: next.expiresAt });
      return next.accessToken;
    } catch {
      tokens.markReconnect(source);
      return null;
    } finally {
      map!.delete(source);
    }
  })();
  map.set(source, job);
  return job;
}
