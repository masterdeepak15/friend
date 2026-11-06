import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { currentRequest, ensureRequest, runWithRequest } from "./auditContext";
import { openDb } from "./db";

const audit = () => new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-ctx-"))));
const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

describe("the request id that follows a request", () => {
  it("makes an id from the prefix, and is not there outside a request", () => {
    expect(currentRequest()).toBeUndefined();
    runWithRequest({ prefix: "chat" }, () => {
      expect(currentRequest()!.requestId).toMatch(/^chat-[0-9a-f]{8}$/);
      expect(currentRequest()!.parentId).toBeNull();
    });
  });

  it("plain nested calls, awaited or not, keep the same id; a nested request is a child of the outer one", async () => {
    await runWithRequest({ prefix: "chat" }, async () => {
      const outer = currentRequest()!.requestId;
      await tick();
      expect(currentRequest()!.requestId).toBe(outer);
      await Promise.all([tick().then(() => currentRequest()!.requestId), (async () => currentRequest()!.requestId)()]).then((ids) => expect(ids).toEqual([outer, outer]));
      runWithRequest({ prefix: "run", actorKind: "worker", actorId: "Dev (be8d8dca)" }, () => {
        const c = currentRequest()!;
        expect(c.requestId).toMatch(/^run-/);
        expect(c.parentId).toBe(outer);
        expect(c).toMatchObject({ actorKind: "worker", actorId: "Dev (be8d8dca)" });
      });
      expect(currentRequest()!.requestId).toBe(outer); // back out
    });
  });

  it("an id and a parent can be given (a worker run points back at the request that made its ticket)", () => {
    runWithRequest({ prefix: "run", requestId: "run-abc12345", parentId: "chat-0001" }, () => {
      expect(currentRequest()).toMatchObject({ requestId: "run-abc12345", parentId: "chat-0001" });
    });
    runWithRequest({ prefix: "run", parentId: null }, () => expect(currentRequest()!.parentId).toBeNull());
  });

  it("two requests running at the same time do not mix", async () => {
    const seen: string[][] = [];
    await Promise.all(
      [1, 2].map((n) =>
        runWithRequest({ prefix: `r${n}` }, async () => {
          const mine = currentRequest()!.requestId;
          await tick(n * 3);
          seen.push([mine, currentRequest()!.requestId]);
        }),
      ),
    );
    expect(seen.every(([a, b]) => a === b)).toBe(true);
    expect(new Set(seen.map((s) => s[0])).size).toBe(2);
  });

  it("ensureRequest starts one only when there is none yet", () => {
    ensureRequest("voice", () => expect(currentRequest()!.requestId).toMatch(/^voice-/));
    runWithRequest({ prefix: "chat" }, () => {
      const id = currentRequest()!.requestId;
      ensureRequest("voice", () => expect(currentRequest()!.requestId).toBe(id));
    });
  });

  it("Audit.log and Audit.record take the id from it, and outside a request leave it empty", () => {
    const a = audit();
    a.log("owner", "outside");
    runWithRequest({ prefix: "chat" }, () => {
      const id = currentRequest()!.requestId;
      a.log("owner", "inside");
      a.record({ kind: "tool.start", actorKind: "assistant" });
      a.record({ kind: "explicit", actorKind: "owner", requestId: "mine", parentId: "theirs" });
      const rows = a.list(10);
      expect(rows.find((r) => r.kind === "inside")).toMatchObject({ requestId: id, parentId: null });
      expect(rows.find((r) => r.kind === "tool.start")!.requestId).toBe(id);
      expect(rows.find((r) => r.kind === "explicit")).toMatchObject({ requestId: "mine", parentId: "theirs" });
    });
    expect(a.list(10).find((r) => r.kind === "outside")!.requestId).toBeNull();
  });

  it("inside a worker run, the old 'agent' actor becomes the worker, by name", () => {
    const a = audit();
    runWithRequest({ prefix: "run", actorKind: "worker", actorId: "Dev (be8d8dca)" }, () => a.log("agent", "office.approval", { tool: "Write" }));
    a.log("agent", "tool.call");
    const rows = a.list(10);
    expect(rows.find((r) => r.kind === "office.approval")).toMatchObject({ actorKind: "worker", actorId: "Dev (be8d8dca)", actor: "agent" });
    expect(rows.find((r) => r.kind === "tool.call")).toMatchObject({ actorKind: "assistant" });
  });
});
