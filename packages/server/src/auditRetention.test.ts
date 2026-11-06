import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { pruneAudit } from "./auditRetention";
import { openDb } from "./db";

const DAY = 86_400_000;
/** A log whose first five entries are old (days 0 to 1) and whose next three are recent (day 100). */
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "friend-retention-"));
  const db = openDb(dir);
  let t = 1000;
  const a = new Audit(db, () => t);
  for (let i = 0; i < 4; i++) (t += 1000, a.record({ kind: `old${i}`, actorKind: "owner", detail: { i } }));
  t = 100 * DAY;
  for (let i = 0; i < 3; i++) (t += 1000, a.record({ kind: `new${i}`, actorKind: "owner", detail: { i } }));
  return { dir, db, a, archiveDir: join(dir, "audit-archive") };
}
const now = 101 * DAY;

describe("retention", () => {
  it("keepDays 0 keeps everything", () => {
    const { db, archiveDir } = seeded();
    expect(pruneAudit(db, { keepDays: 0, archive: true, dir: archiveDir, now })).toEqual({ removed: 0, archivePath: null });
  });

  it("archives the old entries, removes them, and leaves a checkpoint; the chain still verifies", () => {
    const { db, a, archiveDir } = seeded();
    const before = a.list(100).length;
    const lastOld = a.list(100).find((r) => r.kind === "old3")!;
    const r = pruneAudit(db, { keepDays: 90, archive: true, dir: archiveDir, now });
    expect(r.removed).toBe(5); // the start entry and the four old ones
    expect(r.archivePath).toBe(join(archiveDir, "audit-1-5.jsonl.gz"));
    const lines = gunzipSync(readFileSync(r.archivePath!)).toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as { id: number; kind: string; hash: string });
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
    expect(lines.at(-1)).toMatchObject({ kind: "old3", hash: lastOld.hash });
    const rows = a.list(100);
    expect(rows).toHaveLength(before - 5 + 1);
    const checkpoint = rows.find((x) => x.kind === "audit.prune")!;
    expect(checkpoint).toMatchObject({ actorKind: "system", detail: { fromId: 1, toId: 5, count: 5, finalHash: lastOld.hash, archive: r.archivePath } });
    expect(a.verify()).toMatchObject({ ok: true, rows: 4 }); // three new entries and the checkpoint
  });

  it("without an archive the checkpoint says so and no file is written", () => {
    const { db, a, archiveDir } = seeded();
    const r = pruneAudit(db, { keepDays: 90, archive: false, dir: archiveDir, now });
    expect(r.archivePath).toBeNull();
    expect(existsSync(archiveDir)).toBe(false);
    expect(a.list(100).find((x) => x.kind === "audit.prune")!.detail.archive).toBeNull();
    expect(a.verify()).toMatchObject({ ok: true });
  });

  it("an archive that cannot be written removes nothing", () => {
    const { db, a, dir } = seeded();
    const blocked = join(dir, "not-a-folder");
    writeFileSync(blocked, "x");
    const before = a.list(100).length;
    expect(() => pruneAudit(db, { keepDays: 90, archive: true, dir: blocked, now })).toThrow();
    expect(a.list(100)).toHaveLength(before);
    expect(a.verify()).toMatchObject({ ok: true });
  });

  it("nothing old enough means nothing happens, and pruning twice is safe", () => {
    const { db, a, archiveDir } = seeded();
    expect(pruneAudit(db, { keepDays: 9999, archive: true, dir: archiveDir, now })).toEqual({ removed: 0, archivePath: null });
    pruneAudit(db, { keepDays: 90, archive: true, dir: archiveDir, now });
    expect(pruneAudit(db, { keepDays: 90, archive: true, dir: archiveDir, now })).toEqual({ removed: 0, archivePath: null });
    expect(a.verify()).toMatchObject({ ok: true });
    // much later, the recent entries and the first checkpoint are old too
    const later = pruneAudit(db, { keepDays: 90, archive: true, dir: archiveDir, now: 300 * DAY });
    expect(later.removed).toBeGreaterThan(0);
    expect(a.verify()).toMatchObject({ ok: true });
  });

  it("a stand-alone edit or delete of an entry is refused by the database", () => {
    const { db } = seeded();
    expect(() => db.prepare("update audit_log set kind = 'x' where id = 2").run()).toThrow(/audit_log is append-only/);
    expect(() => db.prepare("delete from audit_log where id = 2").run()).toThrow(/audit_log is append-only/);
  });

  it("the entries written before the chain existed are removed with the rest when they are old", () => {
    const { db, a, archiveDir } = seeded();
    db.exec("drop trigger audit_no_update");
    db.prepare("update audit_log set legacy = 1 where id = 1").run(); // pretend the first entry predates the chain
    db.exec("create trigger audit_no_update before update on audit_log begin select raise(abort, 'audit_log is append-only'); end;");
    const r = pruneAudit(db, { keepDays: 90, archive: true, dir: archiveDir, now });
    expect(r.removed).toBe(5);
    expect(a.list(100).some((x) => x.id === 1)).toBe(false);
  });
});
