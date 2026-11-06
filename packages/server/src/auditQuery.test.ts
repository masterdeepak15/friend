import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { AuditQuery, groupOf } from "./auditQuery";
import { openDb } from "./db";

let now = 1_000_000;
function seeded() {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-aq-")));
  const a = new Audit(db, () => (now += 1000));
  a.record({ kind: "request", actorKind: "owner", actorId: "owner", requestId: "chat-1", target: "chat", outcome: "started", detail: { text: "run the tests with Dev" } });
  a.record({ kind: "tool.start", actorKind: "assistant", requestId: "chat-1", target: "office.assign", outcome: "started", detail: { tool: "office.assign" } });
  a.record({ kind: "worker.run", actorKind: "worker", actorId: "Dev (be8d8dca)", requestId: "run-1", parentId: "chat-1", target: "Dev", outcome: "started", detail: {} });
  a.record({ kind: "worker.tool", actorKind: "worker", actorId: "Dev (be8d8dca)", requestId: "run-1", parentId: "chat-1", target: "Bash", outcome: "started", detail: { summary: "Bash: npm test" } });
  a.record({ kind: "approval.requested", actorKind: "worker", actorId: "Dev (be8d8dca)", requestId: "run-1", parentId: "chat-1", target: "Bash", outcome: "waiting", detail: { summary: "rm -rf build" } });
  a.record({ kind: "approval.decided", actorKind: "owner", actorId: "owner", requestId: "run-1", parentId: "chat-1", target: "Bash", outcome: "refused", detail: { decision: "deny" } });
  a.record({ kind: "tool.end", actorKind: "assistant", requestId: "chat-1", target: "office.assign", outcome: "done", detail: {} });
  a.record({ kind: "http.request", actorKind: "outsider", actorId: "6.6.6.6", target: "POST /api/login", outcome: "refused", detail: { status: 401, ip: "6.6.6.6" } });
  a.record({ kind: "tool.end", actorKind: "assistant", requestId: "chat-2", target: "fs.write", outcome: "failed", detail: { result: "disk full 100%_free" } });
  a.record({ kind: "settings.changed", actorKind: "owner", target: "", outcome: "done", detail: { changes: [] } });
  return { a, q: new AuditQuery(db) };
}

describe("groups of event kinds", () => {
  it("sorts kinds into the groups the report filters by", () => {
    expect(groupOf("approval.decided")).toBe("approvals");
    expect(groupOf("tool.start")).toBe("tools");
    expect(groupOf("worker.run")).toBe("workers");
    expect(groupOf("ticket.status")).toBe("workers");
    expect(groupOf("office.approval")).toBe("workers");
    expect(groupOf("login.fail")).toBe("logins");
    expect(groupOf("host.refused")).toBe("logins");
    expect(groupOf("request")).toBe("messages");
    expect(groupOf("message.sent")).toBe("messages");
    expect(groupOf("settings.changed")).toBe("settings");
    expect(groupOf("system.start")).toBe("system");
    expect(groupOf("http.request")).toBe("other");
  });
});

describe("AuditQuery", () => {
  it("filters combine: who, kind group, result, time and text", () => {
    const { q } = seeded();
    expect(q.search({ actorKind: "worker" }).every((r) => r.actorKind === "worker")).toBe(true);
    expect(q.search({ actorId: "Dev (be8d8dca)" })).toHaveLength(3);
    expect(q.search({ group: "approvals" }).map((r) => r.kind).sort()).toEqual(["approval.decided", "approval.requested"]);
    expect(q.search({ outcome: "refused" }).map((r) => r.kind).sort()).toEqual(["approval.decided", "http.request"]);
    expect(q.search({ group: "approvals", actorKind: "owner" })).toHaveLength(1);
    expect(q.search({ q: "npm test" }).map((r) => r.kind)).toEqual(["worker.tool"]);
    expect(q.search({ q: "rm -rf" })).toHaveLength(1);
    expect(q.search({ q: "office.assign" }).length).toBeGreaterThanOrEqual(2);
  });

  it("text search treats % and _ as plain characters, and never as SQL", () => {
    const { q } = seeded();
    expect(q.search({ q: "100%_free" })).toHaveLength(1);
    expect(q.search({ q: "%" }).length).toBe(1); // only the entry that has a percent sign
    expect(q.search({ q: "'; drop table audit_log; --" })).toEqual([]);
    expect(q.search({ q: "run" }).length).toBeGreaterThan(0); // the table is still there
  });

  it("time range and pagination by id, newest first", () => {
    const { q } = seeded();
    const all = q.search({});
    expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort((a, b) => b - a));
    const page1 = q.search({ limit: 3 });
    const page2 = q.search({ limit: 3, before: page1.at(-1)!.id });
    expect(page1).toHaveLength(3);
    expect(page2[0]!.id).toBeLessThan(page1.at(-1)!.id);
    const mid = all[5]!.ts;
    expect(q.search({ from: mid }).every((r) => r.ts >= mid)).toBe(true);
    expect(q.search({ to: mid }).every((r) => r.ts <= mid)).toBe(true);
    expect(q.search({ limit: 100_000 }).length).toBe(all.length); // the limit is capped, not trusted
  });

  it("tree nests the requests a request caused under the entry that started them, in order", () => {
    const { q } = seeded();
    const tree = q.tree("chat-1");
    expect(tree.map((n) => n.row.kind)).toEqual(["request", "tool.start", "tool.end"]);
    const starter = tree[1]!; // the assign call is the last chat entry before the run began
    expect(starter.children.map((c) => c.row.kind)).toEqual(["worker.run", "worker.tool", "approval.requested", "approval.decided"]);
    expect(q.tree("nope")).toEqual([]);
  });

  it("attention lists refused, failed and outsider entries since a time, and what was not recorded", () => {
    const { q, a } = seeded();
    a.record({ kind: "tool.start", actorKind: "assistant", target: "fs.read", outcome: "started", detail: { notRecorded: 2 } });
    a.record({ kind: "approval.timeout", actorKind: "system", target: "shell.run", outcome: "refused", detail: {} });
    const kinds = q.attention(0).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["approval.decided", "http.request", "tool.end", "tool.start", "approval.timeout"]));
    expect(q.attention(0).some((r) => r.kind === "request")).toBe(false);
    expect(q.attention(Date.now() + 1_000_000_000)).toEqual([]);
  });

  it("counts and the list of workers", () => {
    const { q } = seeded();
    expect(q.counts({})).toMatchObject({ refused: 2, failed: 1 });
    expect(q.counts({}).total).toBeGreaterThan(8);
    expect(q.workers()).toEqual([{ id: "Dev (be8d8dca)", name: "Dev (be8d8dca)", last: expect.any(Number) }]);
  });
});
