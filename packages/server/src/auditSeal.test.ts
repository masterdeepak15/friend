import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Audit } from "./audit";
import { pruneAudit } from "./auditRetention";
import { parseSeal, sealDue, sealNow, sealText, verifySeal } from "./auditSeal";
import { openDb } from "./db";

const H = "ab".repeat(32);
function log(n = 4) {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-seal-")));
  let t = 1000;
  const a = new Audit(db, () => (t += 1000));
  for (let i = 0; i < n; i++) a.record({ kind: `k${i}`, actorKind: "owner", detail: { i } });
  return { db, a };
}
const tamper = (db: ReturnType<typeof openDb>, sql: string, ...args: unknown[]) => {
  db.exec("drop trigger if exists audit_no_update; drop trigger if exists audit_no_delete;");
  db.prepare(sql).run(...args);
};

describe("the seal text", () => {
  it("round-trips", () => {
    const text = sealText("2026-11-06", 1842, H);
    expect(text).toBe(`Friend audit seal 2026-11-06: rows 1-1842, hash ${H}`);
    expect(parseSeal(text)).toEqual({ date: "2026-11-06", lastId: 1842, hash: H });
    expect(parseSeal(`  ${text}\n`)).toEqual({ date: "2026-11-06", lastId: 1842, hash: H });
  });
  it("refuses anything else", () => {
    for (const bad of ["", "seal", `Friend audit seal 2026-11-06: rows 1-0, hash ${H}`, `Friend audit seal 2026-11-06: rows 1-5, hash xyz`, `Friend audit seal 06-11-2026: rows 1-5, hash ${H}`]) expect(parseSeal(bad)).toBeNull();
  });
});

describe("verifying a seal", () => {
  it("passes on the real chain", () => {
    const { db, a } = log();
    const last = a.last()!;
    expect(verifySeal(db, sealText("2026-11-06", last.id, last.hash))).toEqual({ ok: true });
  });

  it("still passes after later entries are added (the seal is a point in the past)", () => {
    const { db, a } = log();
    const last = a.last()!;
    const seal = sealText("2026-11-06", last.id, last.hash);
    a.log("owner", "later");
    expect(verifySeal(db, seal)).toEqual({ ok: true });
  });

  it("fails when an earlier entry was edited", () => {
    const { db, a } = log();
    const last = a.last()!;
    const seal = sealText("2026-11-06", last.id, last.hash);
    tamper(db, "update audit_log set detail_json = ? where id = 2", JSON.stringify({ i: 99 }));
    expect(verifySeal(db, seal)).toMatchObject({ ok: false, reason: expect.stringMatching(/chain/) });
  });

  it("fails when the whole chain was rewritten (the entry at that place has another hash)", () => {
    const { db, a } = log();
    const last = a.last()!;
    const seal = sealText("2026-11-06", last.id, last.hash);
    tamper(db, "update audit_log set hash = ? where id = ?", "00".repeat(32), last.id);
    expect(verifySeal(db, seal).ok).toBe(false);
  });

  it("fails when entries were removed without a checkpoint, and says the seal is for something that is not there", () => {
    const { db, a } = log();
    const last = a.last()!;
    const seal = sealText("2026-11-06", last.id, last.hash);
    tamper(db, "delete from audit_log where id >= ?", last.id - 1);
    expect(verifySeal(db, seal)).toMatchObject({ ok: false });
    expect(verifySeal(db, sealText("2026-11-06", 9999, H))).toMatchObject({ ok: false, reason: expect.stringMatching(/not in the log|missing/i) });
  });

  it("never vouches for a pruned entry, only points at the archive", () => {
    const { db, a } = log(6);
    const rows = a.list(20);
    const sealAtEnd = sealText("2026-11-06", rows[0]!.id, rows[0]!.hash);
    const mid = rows.find((r) => r.kind === "k2")!;
    // everything is old: prune the lot but the newest few
    const r = pruneAudit(db, { keepDays: 1, archive: false, dir: "", now: 2_000_000_000 });
    expect(r.removed).toBeGreaterThan(0);
    const checkpoint = a.list(20).find((x) => x.kind === "audit.prune")!;
    const toId = checkpoint.detail.toId as number;
    const finalHash = checkpoint.detail.finalHash as string;
    expect(verifySeal(db, sealText("2026-11-06", toId, finalHash))).toMatchObject({ ok: false, reason: expect.stringMatching(/archive/) });
    expect(verifySeal(db, sealText("2026-11-06", mid.id, mid.hash))).toMatchObject({ ok: false, reason: expect.stringMatching(/pruned/) });
    void sealAtEnd;
  });
});

describe("sealing now", () => {
  it("sends the seal and writes it into the log with where it went", async () => {
    const { db, a } = log();
    const last = a.last()!;
    const send = vi.fn(async () => "telegram");
    const r = await sealNow({ db, audit: a, send, now: new Date(2026, 10, 6, 9, 0).getTime() });
    expect(r).toEqual({ sent: true });
    expect(send).toHaveBeenCalledWith(sealText("2026-11-06", last.id, last.hash));
    const entry = a.list(5).find((x) => x.kind === "audit.seal")!;
    expect(entry).toMatchObject({ actorKind: "system", outcome: "done", detail: { date: "2026-11-06", lastId: last.id, hash: last.hash, via: "telegram", seal: sealText("2026-11-06", last.id, last.hash) } });
    expect(verifySeal(db, sealText("2026-11-06", last.id, last.hash))).toEqual({ ok: true });
  });

  it("with no phone way, or one that throws, it still writes the entry and never throws", async () => {
    const { db, a } = log();
    expect(await sealNow({ db, audit: a, send: async () => null, now: Date.now() })).toEqual({ sent: false });
    expect(a.list(3).find((x) => x.kind === "audit.seal")).toMatchObject({ outcome: "failed", detail: { via: null } });
    expect(await sealNow({ db, audit: a, send: async () => { throw new Error("down"); }, now: Date.now() })).toEqual({ sent: false });
  });
});

describe("when the seal is due", () => {
  const at = (h: number, m: number) => new Date(2026, 10, 6, h, m);
  it("once a day, from the set time, and never when it is off", () => {
    expect(sealDue(at(8, 59), "09:00", null)).toBe(false);
    expect(sealDue(at(9, 0), "09:00", null)).toBe(true);
    expect(sealDue(at(15, 30), "09:00", "2026-11-05")).toBe(true);
    expect(sealDue(at(15, 30), "09:00", "2026-11-06")).toBe(false);
    expect(sealDue(at(23, 59), "", null)).toBe(false);
  });
});

describe("a forged checkpoint cannot vouch for a seal", () => {
  it("rows removed by hand and a made-up checkpoint holding the sealed hash do not make the seal pass", () => {
    const { db, a } = log(6);
    const last = a.last()!;
    const seal = sealText("2026-11-06", last.id, last.hash);
    tamper(db, "delete from audit_log where id <= ?", last.id);
    a.record({ kind: "audit.prune", actorKind: "system", detail: { fromId: 1, toId: last.id, finalHash: last.hash, keepDays: 1 } });
    const r = verifySeal(db, seal);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/archive|pruned/);
  });

  it("verify says which checkpoint the log starts after", () => {
    const { db, a } = log(6);
    pruneAudit(db, { keepDays: 1, archive: false, dir: "", now: 86_400_000 + 4500 });
    const v = a.verify();
    expect(v).toMatchObject({ ok: true, startsAfter: { toId: expect.any(Number) } });
  });
});

describe("finding the last seal", () => {
  it("lastSeal gives the newest seal entry even when many reads mention the word", async () => {
    const { AuditQuery } = await import("./auditQuery");
    const { db, a } = log(3);
    await sealNow({ db, audit: a, send: async () => "telegram", now: new Date(2026, 10, 6, 9, 0).getTime() });
    for (let i = 0; i < 30; i++) a.record({ kind: "audit.read", actorKind: "owner", detail: { query: "audit.seal" } });
    const s = new AuditQuery(db).lastSeal();
    expect(s?.kind).toBe("audit.seal");
    expect(s?.detail.date).toBe("2026-11-06");
  });
});

describe("a seal that did not go out is tried again", () => {
  it("sealDue waits half an hour after an attempt, then tries again the same day", () => {
    const at = new Date(2026, 10, 6, 9, 30);
    const attempt = at.getTime() - 10 * 60_000;
    expect(sealDue(at, "09:00", null, attempt)).toBe(false);
    expect(sealDue(at, "09:00", null, at.getTime() - 40 * 60_000)).toBe(true);
    expect(sealDue(at, "09:00", null, null)).toBe(true);
  });

  it("lastSeal({ sent: true }) skips a seal that failed to go out", async () => {
    const { AuditQuery } = await import("./auditQuery");
    const { db, a } = log(3);
    await sealNow({ db, audit: a, send: async () => "telegram", now: new Date(2026, 10, 5, 9, 0).getTime() });
    await sealNow({ db, audit: a, send: async () => null, now: new Date(2026, 10, 6, 9, 0).getTime() });
    expect(new AuditQuery(db).lastSeal()?.detail.date).toBe("2026-11-06");
    expect(new AuditQuery(db).lastSeal({ sent: true })?.detail.date).toBe("2026-11-05");
  });
});
