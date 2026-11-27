import { NO_PC_PERMISSIONS } from "@friend/protocol";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { PcEnroll } from "./enroll";
import { PcStore } from "./store";

const b64 = (b: Buffer) => b.toString("base64url");
/** What a PC does: a secret it keeps and the challenge it sends. */
const pkce = () => {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: b64(createHash("sha256").update(verifier).digest()) };
};

function rig() {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-pc-")));
  let now = 1_000_000;
  const store = new PcStore(db, () => now);
  const enroll = new PcEnroll(db, store, () => now);
  return { db, store, enroll, advance: (ms: number) => (now += ms), now: () => now };
}
const OFFICE = { os: "Windows 11", host: "OFFICE-PC" };

/** A PC added on the screen, started on the PC, approved by the owner. */
function approved(r: ReturnType<typeof rig>, name = "Office") {
  const made = r.store.create({ name, permissions: { ...NO_PC_PERMISSIONS, shell: true } });
  if ("error" in made) throw new Error(made.error);
  const k = pkce();
  const started = r.enroll.start({ enrollmentId: made.enrollmentId, challenge: k.challenge, ...OFFICE });
  if ("error" in started) throw new Error(started.error);
  r.enroll.approve(started.userCode, {});
  return { made, k, started };
}

describe("PCs the owner added", () => {
  it("start with everything off, have a unique name whatever the case, and are listed", () => {
    const r = rig();
    const a = r.store.create({ name: "Office", permissions: NO_PC_PERMISSIONS });
    expect("error" in a).toBe(false);
    expect("error" in r.store.create({ name: "office", permissions: NO_PC_PERMISSIONS })).toBe(true);
    expect(r.store.list().map((p) => [p.name, p.permissions.shell, p.revoked])).toEqual([["Office", false, false]]);
    expect(r.store.byName("OFFICE")?.name).toBe("Office");
  });
});

describe("adding a PC with a code the PC keeps secret (device authorization with PKCE)", () => {
  it("gives the PC its tokens once the owner approved, and nothing before", () => {
    const r = rig();
    const made = r.store.create({ name: "Office", permissions: NO_PC_PERMISSIONS }) as { enrollmentId: string };
    const k = pkce();
    const s = r.enroll.start({ enrollmentId: made.enrollmentId, challenge: k.challenge, ...OFFICE });
    if ("error" in s) throw new Error(s.error);
    expect(s.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.enroll.poll({ deviceCode: s.deviceCode, verifier: k.verifier })).toMatchObject({ pending: true });
    expect(r.enroll.lookup(s.userCode)).toMatchObject({ name: "Office", host: "OFFICE-PC", os: "Windows 11" });
    r.enroll.approve(s.userCode, { permissions: { ...NO_PC_PERMISSIONS, shell: true, folders: ["D:\\shop"] } });
    const got = r.enroll.poll({ deviceCode: s.deviceCode, verifier: k.verifier });
    if (!("access" in got)) throw new Error("no tokens: " + JSON.stringify(got));
    expect(r.enroll.verifyAccess(got.access)).toBe(got.pcId);
    expect(r.store.get(got.pcId)!.permissions).toMatchObject({ shell: true, folders: ["D:\\shop"] });
    expect(r.store.get(got.pcId)).toMatchObject({ os: "Windows 11", host: "OFFICE-PC" });
  });

  it("refuses a wrong verifier, and an enrollment that was already used", () => {
    const r = rig();
    const { started, k, made } = approved(r);
    expect(r.enroll.poll({ deviceCode: started.deviceCode, verifier: pkce().verifier })).toMatchObject({ error: "invalid" });
    expect(r.enroll.poll({ deviceCode: started.deviceCode, verifier: k.verifier })).toHaveProperty("access");
    expect(r.enroll.poll({ deviceCode: started.deviceCode, verifier: k.verifier })).toMatchObject({ error: expect.any(String) });
    const again = r.enroll.start({ enrollmentId: made.enrollmentId, challenge: pkce().challenge, ...OFFICE });
    expect("error" in again).toBe(true);
  });

  it("lets the code expire after ten minutes, and never approves an expired or unknown code", () => {
    const r = rig();
    const made = r.store.create({ name: "Office", permissions: NO_PC_PERMISSIONS }) as { enrollmentId: string };
    const k = pkce();
    const s = r.enroll.start({ enrollmentId: made.enrollmentId, challenge: k.challenge, ...OFFICE });
    if ("error" in s) throw new Error(s.error);
    r.advance(10 * 60_000 + 1);
    expect(r.enroll.lookup(s.userCode)).toBeNull();
    expect(() => r.enroll.approve(s.userCode, {})).toThrow();
    expect(r.enroll.poll({ deviceCode: s.deviceCode, verifier: k.verifier })).toMatchObject({ error: "expired" });
    expect(r.enroll.lookup("ZZZZ-ZZZZ")).toBeNull();
    expect("error" in r.enroll.start({ enrollmentId: "nope", challenge: k.challenge, ...OFFICE })).toBe(true);
  });

  it("an enrollment id that nobody used for a day stops working", () => {
    const r = rig();
    const made = r.store.create({ name: "Office", permissions: NO_PC_PERMISSIONS }) as { enrollmentId: string };
    r.advance(24 * 3600_000 + 1);
    expect("error" in r.enroll.start({ enrollmentId: made.enrollmentId, challenge: pkce().challenge, ...OFFICE })).toBe(true);
  });
});

describe("keeping a PC signed in", () => {
  it("rotates the refresh token, and a refresh token used a second time means it was stolen: the PC is revoked", () => {
    const r = rig();
    const { started, k } = approved(r);
    const first = r.enroll.poll({ deviceCode: started.deviceCode, verifier: k.verifier }) as { refresh: string; access: string; pcId: number };
    const second = r.enroll.refresh(first.refresh);
    if (!("access" in second)) throw new Error("no refresh");
    expect(second.refresh).not.toBe(first.refresh);
    expect(r.enroll.verifyAccess(second.access)).toBe(first.pcId);
    expect(r.enroll.refresh(first.refresh)).toMatchObject({ error: expect.any(String) }); // the old one again
    expect(r.store.get(first.pcId)!.revoked).toBe(true);
    expect(r.enroll.verifyAccess(second.access)).toBeNull();
    expect(r.enroll.refresh(second.refresh)).toMatchObject({ error: expect.any(String) });
  });

  it("an access token lasts an hour", () => {
    const r = rig();
    const { started, k } = approved(r);
    const t = r.enroll.poll({ deviceCode: started.deviceCode, verifier: k.verifier }) as { access: string; pcId: number };
    r.advance(59 * 60_000);
    expect(r.enroll.verifyAccess(t.access)).toBe(t.pcId);
    r.advance(2 * 60_000);
    expect(r.enroll.verifyAccess(t.access)).toBeNull();
  });

  it("revoking ends the tokens at once, and no token is in the database in the clear", () => {
    const r = rig();
    const { started, k } = approved(r);
    const t = r.enroll.poll({ deviceCode: started.deviceCode, verifier: k.verifier }) as { access: string; refresh: string; pcId: number };
    const dump = JSON.stringify([r.db.prepare("select * from pc_tokens").all(), r.db.prepare("select * from pc_enroll").all()]);
    for (const secret of [t.access, t.refresh, started.deviceCode, k.verifier]) expect(dump).not.toContain(secret);
    r.store.revoke(t.pcId);
    expect(r.enroll.verifyAccess(t.access)).toBeNull();
    expect(r.enroll.refresh(t.refresh)).toMatchObject({ error: expect.any(String) });
  });

  it("can remove a PC for good", () => {
    const r = rig();
    const { started, k } = approved(r);
    const t = r.enroll.poll({ deviceCode: started.deviceCode, verifier: k.verifier }) as { pcId: number };
    expect(r.store.remove(t.pcId)).toBe(true);
    expect(r.store.get(t.pcId)).toBeNull();
    expect(r.store.remove(t.pcId)).toBe(false);
  });
});
