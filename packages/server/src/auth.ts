import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Audit } from "./audit";
import type { Db } from "./db";
import { LockoutError, RateLimiter } from "./ratelimit";

export { LockoutError };

export interface Session {
  id: number;
  kind: string;
  expiresAt: number;
}
export interface Device {
  id: number;
  name: string;
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** Wrong passwords or PINs from one address before it is locked out. */
export const LOGIN_TRIES = 3;
const PAIR_TTL_MS = 5 * 60 * 1000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function scryptAsync(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) =>
    scrypt(secret, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? rej(err) : res(key))),
  );
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [alg, saltHex, keyHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(secret, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class Auth {
  private limiter: RateLimiter;
  /** Account-wide limits, so rotating source addresses does not multiply the guesses. */
  private accountLimiter: RateLimiter;

  constructor(private db: Db, private audit: Audit, private clock: () => number = Date.now) {
    // three wrong tries and this address is locked for a minute; every wrong try after that doubles the wait (up to an hour)
    this.limiter = new RateLimiter(clock, LOGIN_TRIES);
    this.accountLimiter = new RateLimiter(clock, 20);
  }

  /** Where a sign-in stands for this address: the wrong tries left, and how long it is locked. Safe to show the visitor. */
  loginState(ip: string): { triesLeft: number; retryAfterMs: number } {
    const key = `login:${ip}`;
    return { triesLeft: this.limiter.triesLeft(key), retryAfterMs: Math.max(this.limiter.lockedFor(key), this.accountLimiter.lockedFor("login:*")) };
  }

  /** Check the locks and count the attempt immediately, before any await, so concurrent guesses cannot slip past. */
  private begin(kind: "login" | "pin", ip: string): () => void {
    const keys: [RateLimiter, string][] = [
      [this.limiter, `${kind}:${ip}`],
      [this.accountLimiter, `${kind}:*`],
    ];
    for (const [l, k] of keys) l.check(k);
    for (const [l, k] of keys) l.fail(k);
    return () => keys.forEach(([l, k]) => l.reset(k));
  }

  hasOwner(): boolean {
    return !!this.db.prepare("select 1 from owner where id = 1").get();
  }

  assistantName(): string {
    const r = this.db.prepare("select assistant_name n from owner where id = 1").get() as { n: string } | undefined;
    return r?.n ?? "Friend";
  }

  async setupOwner(input: { password: string; pin: string; assistantName: string }): Promise<void> {
    if (this.hasOwner()) throw new Error("Owner already exists");
    if (!/^\d{6,}$/.test(input.pin)) throw new Error("PIN must be at least 6 digits");
    if (input.password.length < 8) throw new Error("Password must be at least 8 characters");
    if (!input.assistantName.trim()) throw new Error("Assistant name is required");
    const [ph, pinh] = await Promise.all([hashSecret(input.password), hashSecret(input.pin)]);
    this.db
      .prepare("insert into owner (id, password_hash, pin_hash, assistant_name, created_at) values (1, ?, ?, ?, ?)")
      .run(ph, pinh, input.assistantName.trim(), this.clock());
    this.audit.log("system", "owner.setup", {});
  }

  async login(password: string, ip: string): Promise<{ token: string; expiresAt: number }> {
    const succeeded = this.begin("login", ip);
    const row = this.db.prepare("select password_hash h from owner where id = 1").get() as { h: string } | undefined;
    const ok = row ? await verifySecret(password, row.h) : false;
    if (!ok) {
      this.audit.log("anonymous", "login.fail", { ip });
      throw new Error("Invalid credentials");
    }
    succeeded();
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.clock() + SESSION_TTL_MS;
    this.db
      .prepare("insert into sessions (token_hash, kind, expires_at, ip) values (?, 'web', ?, ?)")
      .run(sha256(token), expiresAt, ip);
    this.audit.log("owner", "login.ok", { ip });
    return { token, expiresAt };
  }

  resolveSession(token: string): Session | null {
    const r = this.db
      .prepare("select id, kind, expires_at e, revoked from sessions where token_hash = ?")
      .get(sha256(token)) as { id: number; kind: string; e: number; revoked: number } | undefined;
    if (!r || r.revoked || r.e <= this.clock()) return null;
    return { id: r.id, kind: r.kind, expiresAt: r.e };
  }

  /** True while the session with this id exists, is not revoked and has not expired. */
  sessionActive(id: number): boolean {
    const r = this.db.prepare("select expires_at e, revoked from sessions where id = ?").get(id) as
      | { e: number; revoked: number }
      | undefined;
    return !!r && !r.revoked && r.e > this.clock();
  }

  revokeSession(token: string): void {
    this.db.prepare("update sessions set revoked = 1 where token_hash = ?").run(sha256(token));
  }

  revokeAll(): void {
    this.db.prepare("update sessions set revoked = 1").run();
    this.audit.log("owner", "sessions.revoke_all", {});
  }

  async verifyPin(pin: string, ip: string): Promise<boolean> {
    const succeeded = this.begin("pin", ip);
    const row = this.db.prepare("select pin_hash h from owner where id = 1").get() as { h: string } | undefined;
    const ok = row ? await verifySecret(pin, row.h) : false;
    if (ok) succeeded();
    else this.audit.log("owner", "pin.fail", { ip });
    return ok;
  }

  /** Checks a new password and/or PIN the same way setup does. Returns the problem, or null when both are fine. */
  static checkNewSecrets(input: { newPassword?: string | undefined; newPin?: string | undefined }): string | null {
    if (input.newPassword === undefined && input.newPin === undefined) return "Give a new password or a new PIN.";
    if (input.newPin !== undefined && !/^\d{6,}$/.test(input.newPin)) return "PIN must be at least 6 digits";
    if (input.newPassword !== undefined && input.newPassword.length < 8) return "Password must be at least 8 characters";
    return null;
  }

  private async store(input: { newPassword?: string | undefined; newPin?: string | undefined }): Promise<void> {
    if (input.newPassword !== undefined) this.db.prepare("update owner set password_hash = ? where id = 1").run(await hashSecret(input.newPassword));
    if (input.newPin !== undefined) this.db.prepare("update owner set pin_hash = ? where id = 1").run(await hashSecret(input.newPin));
  }

  /**
   * Changes the password and/or PIN of a signed-in owner who proves it with the current password. Wrong guesses count toward
   * the same sign-in lock. A new password signs every other browser out (the one in `keepToken` stays signed in).
   */
  async changeSecrets(input: { current: string; newPassword?: string | undefined; newPin?: string | undefined }, ip: string, keepToken?: string): Promise<void> {
    const problem = Auth.checkNewSecrets(input);
    if (problem) throw new Error(problem);
    const succeeded = this.begin("login", ip);
    const row = this.db.prepare("select password_hash h from owner where id = 1").get() as { h: string } | undefined;
    const ok = row ? await verifySecret(input.current, row.h) : false;
    if (!ok) {
      this.audit.log("owner", "secrets.fail", { ip });
      throw new Error("Invalid credentials");
    }
    succeeded();
    await this.store(input);
    if (input.newPassword !== undefined) {
      if (keepToken) this.db.prepare("update sessions set revoked = 1 where token_hash != ?").run(sha256(keepToken));
      else this.db.prepare("update sessions set revoked = 1").run();
    }
    this.audit.log("owner", "secrets.changed", { password: input.newPassword !== undefined, pin: input.newPin !== undefined });
  }

  /** For `friend password` / `friend pin` run on this PC: no current password needed (being on the PC is the proof). Signs everyone out. */
  async resetSecrets(input: { newPassword?: string | undefined; newPin?: string | undefined }): Promise<void> {
    if (!this.hasOwner()) throw new Error("There is no owner yet. Run: friend setup");
    const problem = Auth.checkNewSecrets(input);
    if (problem) throw new Error(problem);
    await this.store(input);
    if (input.newPassword !== undefined) this.db.prepare("update sessions set revoked = 1").run();
    this.audit.log("system", "secrets.reset", { password: input.newPassword !== undefined, pin: input.newPin !== undefined });
  }

  createPairCode(): string {
    const code = randomBytes(5).toString("hex").toUpperCase();
    this.db
      .prepare("insert into pair_codes (code_hash, expires_at) values (?, ?)")
      .run(sha256(code), this.clock() + PAIR_TTL_MS);
    return code;
  }

  redeemPairCode(code: string, deviceName: string): string {
    const h = sha256(code.trim().toUpperCase());
    const r = this.db.prepare("select expires_at e from pair_codes where code_hash = ?").get(h) as { e: number } | undefined;
    this.db.prepare("delete from pair_codes where code_hash = ?").run(h);
    if (!r || r.e <= this.clock()) {
      this.audit.log("device", "pair.fail", { deviceName });
      throw new Error("Invalid or expired pairing code");
    }
    const token = randomBytes(32).toString("hex");
    this.db.prepare("insert into devices (name, token_hash, last_seen) values (?, ?, ?)").run(deviceName, sha256(token), this.clock());
    this.audit.log("device", "pair.ok", { deviceName });
    return token;
  }

  listDevices(): { id: number; name: string; lastSeen: number | null }[] {
    const rows = this.db.prepare("select id, name, last_seen from devices order by id").all() as {
      id: number;
      name: string;
      last_seen: number | null;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, lastSeen: r.last_seen }));
  }

  revokeDevice(id: number): void {
    this.db.prepare("delete from devices where id = ?").run(id);
    this.audit.log("owner", "device.revoked", { id });
  }

  resolveDevice(token: string): Device | null {
    const r = this.db.prepare("select id, name from devices where token_hash = ?").get(sha256(token)) as Device | undefined;
    if (!r) return null;
    this.db.prepare("update devices set last_seen = ? where id = ?").run(this.clock(), r.id);
    return r;
  }
}
