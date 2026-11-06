import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit, AuditWriteError } from "../audit";
import { runWithRequest } from "../auditContext";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

let emitted: ServerMsg[];
let decision: "approve" | "deny";
let approvals: Approvals;
let audit: Audit;
let exec: ReturnType<typeof vi.fn>;
let build: (provider: FakeProvider) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? "123456" : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const run = (agent: Agent, say: string) => runWithRequest({ prefix: "chat" }, () => agent.runTurn(say, ctx));
const entries = (kind: string) => audit.list(100).filter((r) => r.kind === kind).reverse();
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls.at(-1)!.messages.at(-1));

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  exec = vi.fn(async () => ({ ok: true as const, output: "info about this PC", truncated: false }));
  const dir = mkdtempSync(join(tmpdir(), "friend-loop-audit-"));
  const db = openDb(dir);
  audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider) => new Agent({ provider, policy, approvals, devices: { exec, hasOnline: () => true, targetName: () => "pc" } as never, stage: new StageState(), db, audit, config, assistantName: () => "Jarvis" });
});

describe("every tool call is recorded before and after it runs", () => {
  it("writes tool.start before it runs and tool.end after, with the exact arguments and the start of the result", async () => {
    let seenAtRun: string[] = [];
    exec.mockImplementationOnce(async () => {
      seenAtRun = audit.list(10).map((r) => r.kind);
      return { ok: true as const, output: "x".repeat(1000), truncated: false };
    });
    const provider = new FakeProvider([[call("c1", "system.info", {}), done], [text("ok"), done]]);
    await run(build(provider), "what is this PC");
    expect(seenAtRun).toContain("tool.start"); // written before the tool ran
    const [start] = entries("tool.start");
    const [end] = entries("tool.end");
    expect(start).toMatchObject({ actorKind: "assistant", target: "system.info", outcome: "started", detail: { tool: "system.info", args: {} } });
    expect(end).toMatchObject({ target: "system.info", outcome: "done" });
    expect(String(end!.detail.result).length).toBe(300);
    expect(end!.requestId).toBe(start!.requestId);
    expect(start!.requestId).toMatch(/^chat-/);
    expect(audit.verify()).toMatchObject({ ok: true });
  });

  it("masks secrets in the arguments", async () => {
    const provider = new FakeProvider([[call("c1", "fs.write", { path: "C:\\x.txt", content: "token=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", password: "p" }), done], [text("ok"), done]]);
    decision = "deny";
    await run(build(provider), "write it");
    const [start] = entries("tool.start");
    expect(JSON.stringify(start!.detail)).not.toMatch(/sk-ant-api03/);
    expect(start!.detail.args).toMatchObject({ password: "[redacted]" });
  });

  it("a tool the owner refuses ends as refused", async () => {
    decision = "deny";
    const provider = new FakeProvider([[call("c1", "fs.write", { path: "C:\\x.txt", content: "hi" }), done], [text("ok"), done]]);
    await run(build(provider), "write it");
    expect(entries("tool.end")[0]).toMatchObject({ outcome: "refused", target: "fs.write" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("a tool that reports an error, or throws, ends as failed and still leaves its start", async () => {
    exec.mockResolvedValueOnce({ ok: false as const, error: "boom" });
    exec.mockRejectedValueOnce(new Error("exploded"));
    const provider = new FakeProvider([[call("c1", "system.info", {}), done], [call("c2", "system.info", {}), done], [text("ok"), done]]);
    await run(build(provider), "twice").catch(() => {});
    expect(entries("tool.start").length).toBeGreaterThanOrEqual(2);
    const ends = entries("tool.end");
    expect(ends.length).toBeGreaterThanOrEqual(1);
    expect(ends.every((e) => e.outcome === "failed")).toBe(true);
  });
});

describe("when the record cannot be written", () => {
  it("a tool that changes something is not run, the model and the owner are told", async () => {
    const spy = vi.spyOn(audit, "record").mockImplementation(() => {
      throw new AuditWriteError("disk full");
    });
    const provider = new FakeProvider([[call("c1", "stage.clear", {}), done], [text("ok"), done]]);
    await run(build(provider), "clear the screen");
    expect(lastTool(provider)).toContain("could not be recorded");
    expect(emitted.some((m) => m.type === "alert" && m.level === "error" && /could not be recorded/.test(m.text))).toBe(true);
    spy.mockRestore();
    expect(entries("tool.end")).toHaveLength(0);
  });

  it("a read-only tool still runs, and the next entry says one was not recorded", async () => {
    const spy = vi.spyOn(audit, "record").mockImplementation(() => {
      throw new AuditWriteError("disk full");
    });
    const provider = new FakeProvider([[call("c1", "system.info", {}), done], [text("ok"), done], [call("c2", "system.info", {}), done], [text("ok"), done]]);
    const agent = build(provider);
    await run(agent, "info");
    expect(exec).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    await run(agent, "info again");
    const [first] = entries("tool.start");
    expect(first!.detail.notRecorded).toBeGreaterThanOrEqual(1);
  });
});
