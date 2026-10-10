import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "./types";

const STATE_TTL_MS = 10 * 60_000;
const MAX_STATES = 20;
const BROKER_ID = /^[a-z0-9-]{1,40}$/;

/**
 * Where a broker's daily access token is kept (its own file in the data folder, readable by the owner only, deleted when
 * it expires) and the one-time codes that tie a login return to a login Friend started.
 */
export class BrokerSessions {
  private states = new Map<string, { broker: string; at: number }>();

  constructor(
    private dir: string,
    private clock: () => number = Date.now,
  ) {}

  private file(broker: string): string {
    if (!BROKER_ID.test(broker)) throw new Error("That is not a broker id.");
    return join(this.dir, `broker-${broker}.session.json`);
  }

  save(broker: string, info: SessionInfo): void {
    const file = this.file(broker);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ accessToken: info.accessToken, expiresAt: info.expiresAt }), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* permission bits unsupported on this system */
    }
  }

  /** The saved session, or null when there is none, it has expired (the file is deleted then) or the file is damaged. */
  load(broker: string): SessionInfo | null {
    if (!BROKER_ID.test(broker)) return null;
    const file = this.file(broker);
    if (!existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionInfo>;
      if (typeof raw.accessToken !== "string" || typeof raw.expiresAt !== "number") return null;
      if (raw.expiresAt <= this.clock()) {
        this.clear(broker);
        return null;
      }
      return { accessToken: raw.accessToken, expiresAt: raw.expiresAt };
    } catch {
      return null;
    }
  }

  clear(broker: string): void {
    if (!BROKER_ID.test(broker)) return;
    rmSync(this.file(broker), { force: true });
  }

  /** A fresh unguessable code for one login at `broker`. At most twenty wait at once; the oldest is dropped. */
  newState(broker: string): string {
    const state = randomBytes(24).toString("hex");
    this.states.set(state, { broker, at: this.clock() });
    while (this.states.size > MAX_STATES) this.states.delete(this.states.keys().next().value!);
    return state;
  }

  /** The broker a code was made for, once. A replay, an expired code or anything not made here gives null. */
  takeState(state: string): string | null {
    if (typeof state !== "string" || state.length === 0 || state.length > 200) return null;
    const found = this.states.get(state);
    if (!found) return null;
    this.states.delete(state);
    return this.clock() - found.at <= STATE_TTL_MS ? found.broker : null;
  }
}
