import { PcPermissions } from "@friend/protocol";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db";
import type { PcStore } from "./store";

/** How long a PC has to be approved once it asked. */
export const CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
/** Letters and digits that cannot be mistaken for each other. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");
const userCode = (): string => {
  const pick = (): string => Array.from(randomBytes(4), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${pick()}-${pick()}`;
};
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export type Started = { deviceCode: string; userCode: string; interval: number; expiresIn: number };
export type Polled = { pending: true; interval: number } | { access: string; refresh: string; pcId: number; expiresIn: number } | { error: "invalid" | "expired" | "used" | "denied" };
export type Refreshed = { access: string; refresh: string; pcId: number; expiresIn: number } | { error: string };

interface EnrollRow {
  id: string;
  pc_id: number;
  user_code: string | null;
  device_hash: string | null;
  challenge: string | null;
  expires_at: number;
  approved: number;
  used: number;
  os: string | null;
  host: string | null;
}

/**
 * How a PC signs in: it keeps a secret (the verifier) and sends only its hash (the challenge) with the one-time enrollment id
 * from its install command; the owner approves a short code; the PC then proves it is the same program by sending the verifier.
 * Nothing the PC holds can be used by someone who only saw the approval page, and the tokens are stored hashed.
 */
export class PcEnroll {
  constructor(
    private readonly db: Db,
    private readonly store: PcStore,
    private readonly clock: () => number = Date.now,
  ) {}

  start(input: { enrollmentId: string; challenge: string; os: string; host: string }): Started | { error: string } {
    const row = this.db.prepare("select * from pc_enroll where id = ?").get(input.enrollmentId) as EnrollRow | undefined;
    const now = this.clock();
    if (!row || row.used || row.approved || (row.user_code === null && row.expires_at < now) || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge)) return { error: "This install link is not valid any more. Add the PC again." };
    const pc = this.store.get(row.pc_id);
    if (!pc || pc.revoked) return { error: "This PC was removed." };
    const deviceCode = token();
    const code = userCode();
    this.db
      .prepare("update pc_enroll set user_code = ?, device_hash = ?, challenge = ?, expires_at = ?, os = ?, host = ? where id = ?")
      .run(code, sha(deviceCode), input.challenge, now + CODE_TTL_MS, input.os.slice(0, 80), input.host.slice(0, 80), row.id);
    return { deviceCode, userCode: code, interval: 3, expiresIn: CODE_TTL_MS / 1000 };
  }

  /** What the owner sees on the approval page, or null when the code is unknown, used or expired. */
  lookup(code: string): { pcId: number; name: string; os: string; host: string; permissions: PcPermissions } | null {
    const row = this.live(code);
    if (!row) return null;
    const pc = this.store.get(row.pc_id);
    return pc && !pc.revoked ? { pcId: pc.id, name: pc.name, os: row.os ?? "", host: row.host ?? "", permissions: pc.permissions } : null;
  }

  /** The owner approved. Throws when the code is not valid. */
  approve(code: string, choices: { permissions?: PcPermissions; name?: string }): number {
    const row = this.live(code);
    if (!row) throw new Error("That code is not valid or has expired.");
    const pc = this.store.get(row.pc_id);
    if (!pc || pc.revoked) throw new Error("This PC was removed.");
    if (choices.permissions && !this.store.setPermissions(pc.id, choices.permissions)) throw new Error("Those permissions are not valid.");
    if (choices.name && choices.name !== pc.name && !this.store.rename(pc.id, choices.name)) throw new Error("That name is taken or not valid.");
    this.store.setIdentity(pc.id, row.os ?? "", row.host ?? "");
    this.db.prepare("update pc_enroll set approved = 1 where id = ?").run(row.id);
    return pc.id;
  }

  /** The PC asks whether it was approved, proving it is the one that started with the verifier. */
  poll(input: { deviceCode: string; verifier: string }): Polled {
    const row = this.db.prepare("select * from pc_enroll where device_hash = ?").get(sha(input.deviceCode)) as EnrollRow | undefined;
    if (!row || !row.challenge) return { error: "invalid" };
    if (row.used) return { error: "used" };
    if (row.expires_at < this.clock()) return { error: "expired" };
    if (!same(createHash("sha256").update(input.verifier).digest("base64url"), row.challenge)) return { error: "invalid" };
    if (!row.approved) return { pending: true, interval: 3 };
    const pc = this.store.get(row.pc_id);
    if (!pc || pc.revoked) return { error: "denied" };
    this.db.prepare("update pc_enroll set used = 1 where id = ?").run(row.id);
    return this.issue(pc.id);
  }

  /** Trades a refresh token for a new pair. An old refresh token used again means a copy exists: the PC is revoked. */
  refresh(refresh: string): Refreshed {
    const h = sha(refresh);
    const cur = this.db.prepare("select * from pc_tokens where refresh_hash = ?").get(h) as { id: number; pc_id: number } | undefined;
    if (!cur) {
      const old = this.db.prepare("select pc_id from pc_tokens where previous_refresh_hash = ?").get(h) as { pc_id: number } | undefined;
      if (old) this.store.revoke(old.pc_id);
      return { error: "That sign-in is no longer valid. Add the PC again." };
    }
    const pc = this.store.get(cur.pc_id);
    if (!pc || pc.revoked) return { error: "This PC was revoked." };
    const next = this.issue(pc.id, h);
    this.db.prepare("delete from pc_tokens where id = ?").run(cur.id);
    return next;
  }

  /** The PC a valid access token belongs to, or null. */
  verifyAccess(access: string): number | null {
    const row = this.db.prepare("select pc_id, access_expires from pc_tokens where access_hash = ?").get(sha(access)) as { pc_id: number; access_expires: number } | undefined;
    if (!row || row.access_expires < this.clock()) return null;
    const pc = this.store.get(row.pc_id);
    return pc && !pc.revoked ? pc.id : null;
  }

  private issue(pcId: number, previousRefreshHash?: string): { access: string; refresh: string; pcId: number; expiresIn: number } {
    const access = token();
    const refresh = token();
    const now = this.clock();
    this.db
      .prepare("insert into pc_tokens (pc_id, access_hash, access_expires, refresh_hash, previous_refresh_hash, created_at) values (?, ?, ?, ?, ?, ?)")
      .run(pcId, sha(access), now + ACCESS_TTL_MS, sha(refresh), previousRefreshHash ?? null, now);
    return { access, refresh, pcId, expiresIn: ACCESS_TTL_MS / 1000 };
  }

  private live(code: string): EnrollRow | null {
    const row = this.db.prepare("select * from pc_enroll where user_code = ?").get(code.trim().toUpperCase()) as EnrollRow | undefined;
    return row && !row.used && !row.approved && row.expires_at >= this.clock() ? row : null;
  }
}
