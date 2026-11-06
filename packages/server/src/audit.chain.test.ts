import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { openDb, type Db } from "./db";
import { MIGRATIONS } from "./migrations";

const dir = () => mkdtempSync(join(tmpdir(), "friend-audit-chain-"));
/** Tampering for the tests: the append-only triggers (added later) are taken away first. */
const tamper = (db: Db, sql: string, ...args: unknown[]) => {
  db.exec("drop trigger if exists audit_no_update; drop trigger if exists audit_no_delete;");
  db.prepare(sql).run(...args);
};

describe("the audit chain", () => {
  it("links each entry to the one before it", () => {
    const db = openDb(dir());
    const a = new Audit(db);
    a.log("owner", "one", { n: 1 });
    a.log("agent", "two", { n: 2 });
    a.log("system", "three", { n: 3 });
    const rows = a.list(10); // newest first
    expect(rows.map((r) => r.kind)).toEqual(["three", "two", "one", "audit.start"]);
    expect(rows[0]!.prevHash).toBe(rows[1]!.hash);
    expect(rows[1]!.prevHash).toBe(rows[2]!.hash);
    expect(rows[2]!.prevHash).toBe(rows[3]!.hash);
    expect(rows[3]!.prevHash).toBe("");
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    expect(a.verify()).toEqual({ ok: true, rows: 4, lastHash: rows[0]!.hash });
  });

  it("a fresh log verifies with only its start-of-chain entry", () => {
    const a = new Audit(openDb(dir()));
    const v = a.verify();
    expect(v).toMatchObject({ ok: true, rows: 1 });
  });

  it("editing an entry's detail breaks the chain at that entry", () => {
    const db = openDb(dir());
    const a = new Audit(db);
    a.log("owner", "one");
    const id = a.record({ kind: "two", actorKind: "assistant", detail: { cmd: "ls" } });
    a.log("owner", "three");
    tamper(db, "update audit_log set detail_json = ? where id = ?", JSON.stringify({ cmd: "rm -rf" }), id);
    expect(a.verify()).toEqual({ ok: false, brokenAt: id, reason: "hash" });
  });

  it("deleting an entry from the middle breaks the chain at the next one", () => {
    const db = openDb(dir());
    const a = new Audit(db);
    a.log("owner", "one");
    const mid = a.record({ kind: "two", actorKind: "owner" });
    const after = a.record({ kind: "three", actorKind: "owner" });
    tamper(db, "delete from audit_log where id = ?", mid);
    expect(a.verify()).toEqual({ ok: false, brokenAt: after, reason: "link" });
  });

  it("marks the entries that existed before as legacy and starts the chain with one entry that counts them", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const raw = new Database(join(d, "friend.db"));
    raw.exec("create table schema_version (id integer primary key, applied_at integer not null)");
    for (const m of MIGRATIONS.filter((x) => x.id <= 15)) {
      raw.exec(m.sql);
      raw.prepare("insert into schema_version (id, applied_at) values (?, ?)").run(m.id, 1);
    }
    for (let i = 0; i < 3; i++) raw.prepare("insert into audit_log (ts, actor, kind, detail_json) values (?, ?, ?, ?)").run(1000 + i, "owner", `old${i}`, "{}");
    raw.close();
    const db = openDb(d); // runs the new migration
    const a = new Audit(db);
    a.log("owner", "new");
    const all = db.prepare("select kind, legacy from audit_log order by id").all() as { kind: string; legacy: number }[];
    expect(all.filter((r) => r.legacy === 1).map((r) => r.kind)).toEqual(["old0", "old1", "old2"]);
    const start = a.list(10).find((r) => r.kind === "audit.start")!;
    expect(start.detail).toEqual({ legacyRows: 3 });
    expect(a.verify()).toMatchObject({ ok: true, rows: 2 }); // the start entry and the new one
  });

  it("two writers on the same database (Friend and a command-line command) keep one valid chain", () => {
    const d = dir();
    const a = new Audit(openDb(d));
    const b = new Audit(openDb(d));
    for (let i = 0; i < 20; i++) (i % 2 ? a : b).log("system", `k${i}`, { i });
    const v = a.verify();
    expect(v).toMatchObject({ ok: true, rows: 21 });
    expect(b.verify()).toEqual(v);
  });

  it("a clock that goes backwards, or stands still, still verifies (order is by id, not by time)", () => {
    const times = [5000, 1000, 1000, 9000];
    let i = 0;
    const a = new Audit(openDb(dir()), () => times[i++ % times.length]!);
    for (let n = 0; n < 6; n++) a.log("owner", `k${n}`);
    expect(a.verify()).toMatchObject({ ok: true, rows: 7 });
  });

  it("log() gives the old actor text a kind, and record() returns the id", () => {
    const a = new Audit(openDb(dir()));
    a.log("agent", "a");
    a.log("anonymous", "b");
    a.log("owner", "c");
    a.log("something-else", "d");
    const id = a.record({ kind: "e", actorKind: "worker", actorId: "Dev (be8d8dca)", target: "Write a.txt", outcome: "done", requestId: "run-1", parentId: "chat-1", detail: { ok: true } });
    const rows = a.list(10);
    expect(rows.slice(1, 5).map((r) => r.actorKind)).toEqual(["system", "owner", "outsider", "assistant"]);
    expect(rows[0]).toMatchObject({ id, kind: "e", actorKind: "worker", actorId: "Dev (be8d8dca)", target: "Write a.txt", outcome: "done", requestId: "run-1", parentId: "chat-1", legacy: false });
    expect(rows[0]!.detail).toEqual({ ok: true });
  });

  it("an old-style entry gets a target from what its detail names (the tool, the worker, the ticket)", () => {
    const a = new Audit(openDb(dir()));
    a.log("agent", "office.hire", { worker: "Dev", project: "site" });
    a.log("agent", "tool.call", { tool: "fs.read" });
    a.log("agent", "office.review", { ticket: 14, accept: true });
    a.log("owner", "login.ok", { ip: "1.1.1.1" });
    const rows = a.list(4);
    expect(rows.map((r) => r.target)).toEqual(["", "14", "fs.read", "Dev"]);
  });
});
