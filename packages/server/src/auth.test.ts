import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { Auth, LockoutError, hashSecret, verifySecret } from "./auth";
import { openDb } from "./db";

let now = 1_000_000;
let db: ReturnType<typeof openDb>;
let audit: Audit;
let auth: Auth;
const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };

beforeEach(() => {
  now = 1_000_000;
  db = openDb(mkdtempSync(join(tmpdir(), "friend-auth-")));
  audit = new Audit(db, () => now);
  auth = new Auth(db, audit, () => now);
});

describe("secret hashing", () => {
  it("verifies the right secret and rejects the wrong one", async () => {
    const h = await hashSecret("abc12345");
    expect(await verifySecret("abc12345", h)).toBe(true);
    expect(await verifySecret("abc12346", h)).toBe(false);
  });
});

describe("setupOwner", () => {
  it("rejects a PIN shorter than 6 digits or non-numeric", async () => {
    await expect(auth.setupOwner({ ...owner, pin: "12345" })).rejects.toThrow(/PIN/);
    await expect(auth.setupOwner({ ...owner, pin: "12ab56" })).rejects.toThrow(/PIN/);
  });
  it("refuses a second owner", async () => {
    await auth.setupOwner(owner);
    expect(auth.hasOwner()).toBe(true);
    await expect(auth.setupOwner(owner)).rejects.toThrow(/already/);
  });
});

describe("login and sessions", () => {
  beforeEach(async () => { await auth.setupOwner(owner); });

  it("returns a token for the right password and resolves it", async () => {
    const s = await auth.login(owner.password, "1.1.1.1");
    expect(auth.resolveSession(s.token)).not.toBeNull();
  });
  it("throws and audits on a wrong password", async () => {
    await expect(auth.login("nope nope nope", "1.1.1.1")).rejects.toThrow();
    expect(audit.list(10).some((r) => r.kind === "login.fail")).toBe(true);
  });
  it("locks an IP after 5 failures until the clock advances", async () => {
    for (let i = 0; i < 5; i++) await expect(auth.login("bad bad bad", "2.2.2.2")).rejects.toThrow();
    await expect(auth.login(owner.password, "2.2.2.2")).rejects.toBeInstanceOf(LockoutError);
    now += 2 * 60 * 60 * 1000;
    await expect(auth.login(owner.password, "2.2.2.2")).resolves.toBeTruthy();
  });
  it("rate limits verifyPin the same way", async () => {
    for (let i = 0; i < 5; i++) expect(await auth.verifyPin("000000", "3.3.3.3")).toBe(false);
    await expect(auth.verifyPin(owner.pin, "3.3.3.3")).rejects.toBeInstanceOf(LockoutError);
  });
  it("verifies the right PIN", async () => {
    expect(await auth.verifyPin(owner.pin, "4.4.4.4")).toBe(true);
  });
  it("returns null for expired and revoked sessions", async () => {
    const a = await auth.login(owner.password, "5.5.5.5");
    now += 30 * 24 * 3600 * 1000;
    expect(auth.resolveSession(a.token)).toBeNull();
    const b = await auth.login(owner.password, "5.5.5.5");
    auth.revokeAll();
    expect(auth.resolveSession(b.token)).toBeNull();
  });
  it("stores only hashes of tokens", async () => {
    const s = await auth.login(owner.password, "6.6.6.6");
    const rows = JSON.stringify(db.prepare("select * from sessions").all());
    expect(rows).not.toContain(s.token);
  });
});

describe("device pairing", () => {
  beforeEach(async () => { await auth.setupOwner(owner); });

  it("redeems a pair code once", () => {
    const code = auth.createPairCode();
    const tok = auth.redeemPairCode(code, "laptop");
    expect(auth.resolveDevice(tok)?.name).toBe("laptop");
    expect(() => auth.redeemPairCode(code, "again")).toThrow();
  });
  it("expires a pair code after 5 minutes", () => {
    const code = auth.createPairCode();
    now += 5 * 60 * 1000 + 1;
    expect(() => auth.redeemPairCode(code, "late")).toThrow();
  });
  it("rejects unknown device tokens", () => {
    expect(auth.resolveDevice("bogus")).toBeNull();
  });
});

describe("audit", () => {
  it("never stores the password or PIN", async () => {
    await auth.setupOwner(owner);
    await auth.login(owner.password, "7.7.7.7");
    await auth.verifyPin(owner.pin, "7.7.7.7");
    const all = JSON.stringify(audit.list(100));
    expect(all).not.toContain(owner.password);
    expect(all).not.toContain(owner.pin);
  });
  it("redacts secret-looking keys in detail", () => {
    audit.log("x", "test", { password: "hunter2", pin: "999999", token: "t", ok: 1 });
    const row = audit.list(1)[0]!;
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect(JSON.stringify(row)).toContain('"ok":1');
  });
});
