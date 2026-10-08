import { describeCall, type ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import type { CodeBox, RunResult } from "../codebox";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name: "code.run", args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

let emitted: ServerMsg[];
let decision: "approve" | "deny";
let approvals: Approvals;
let run: ReturnType<typeof vi.fn<CodeBox["run"]>>;
let build: (provider: FakeProvider, withBox?: boolean) => Agent;
const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? "123456" : undefined }, "9.9.9.9");
};
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit, ip: "9.9.9.9" });
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls[1]!.messages.at(-1));
const ok = (r: Partial<Extract<RunResult, { ok: true }>> = {}): RunResult => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r });

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  run = vi.fn<CodeBox["run"]>(async () => ok({ stdout: "42\n" }));
  const dir = mkdtempSync(join(tmpdir(), "friend-codeagent-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 300);
  build = (provider, withBox = true) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      ...(withBox ? { code: { run } } : {}),
    });
});

describe("code.run", () => {
  it("asks the owner, shows the whole program, then runs it and hands back the output", async () => {
    const code = "x = 6 * 7\n" + "# filler\n".repeat(400) + "print(x)  # THE-END";
    const p = new FakeProvider([[call("1", { language: "python", code }), done], [text("It is 42."), done]]);
    await build(p).runTurn("what is 6 times 7?", ctx());
    const card = emitted.find((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>;
    expect(card).toMatchObject({ tool: "code.run", tier: "T2", needsPin: false });
    expect(card.summary).toContain("THE-END"); // what the owner approves is never cut short
    expect(card.summary).toMatch(/no network/i);
    expect(run).toHaveBeenCalledWith({ language: "python", code, timeoutSec: undefined });
    expect(lastTool(p)).toContain("exit code 0");
    expect(lastTool(p)).toContain("42");
  });

  it("does not run anything when the owner says no", async () => {
    decision = "deny";
    const p = new FakeProvider([[call("1", { language: "shell", code: "echo hi" }), done], [text("ok"), done]]);
    await build(p).runTurn("run it", ctx());
    expect(run).not.toHaveBeenCalled();
    expect(lastTool(p)).toMatch(/did not approve/i);
  });

  it("reports errors, partial output and time limits in words", async () => {
    run.mockResolvedValueOnce(ok({ exitCode: 1, stdout: "partial\n", stderr: "ZeroDivisionError: division by zero" }));
    run.mockResolvedValueOnce(ok({ exitCode: 137, timedOut: true, stdout: "tick\n" }));
    const p = new FakeProvider([
      [call("1", { language: "python", code: "1/0" }), call("2", { language: "python", code: "while True: pass", timeoutSec: 5 }), done],
      [text("done"), done],
    ]);
    await build(p).runTurn("go", ctx());
    const out = JSON.parse(lastTool(p)).content as { content: string }[];
    expect(out[0]!.content).toMatch(/exit code 1/);
    expect(out[0]!.content).toContain("ZeroDivisionError");
    expect(out[0]!.content).toContain("partial");
    expect(out[1]!.content).toMatch(/stopped.*time limit/i);
    expect(out[1]!.content).toContain("tick");
  });

  it("turns a docker problem into a plain tool error", async () => {
    run.mockResolvedValueOnce({ ok: false, error: "Docker is not running. Start Docker Desktop and try again." });
    const p = new FakeProvider([[call("1", { language: "python", code: "1" }), done], [text("ok"), done]]);
    await build(p).runTurn("go", ctx());
    expect(JSON.parse(lastTool(p)).content[0]).toMatchObject({ isError: true, content: expect.stringContaining("Docker is not running") });
  });

  it("rejects an unknown language or missing code before asking the owner", async () => {
    const p = new FakeProvider([[call("1", { language: "ruby", code: "puts 1" }), call("2", { language: "python" }), done], [text("ok"), done]]);
    await build(p).runTurn("go", ctx());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(lastTool(p)).toMatch(/Invalid arguments/);
  });

  it("says so when this server has no code runner", async () => {
    const p = new FakeProvider([[call("1", { language: "python", code: "1" }), done], [text("ok"), done]]);
    await build(p, false).runTurn("go", ctx());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(lastTool(p)).toContain("Running code is not available.");
  });

  it("is never available to a guest", async () => {
    const p = new FakeProvider([[call("1", { language: "python", code: "1" }), done], [text("no"), done]]);
    await build(p).runTurn("go", ctx("guest"));
    expect(run).not.toHaveBeenCalled();
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
  });
});

describe("describeCall for code.run", () => {
  it("states the language, the walls and the full code", () => {
    const s = describeCall("code.run", { language: "node", code: "console.log(1)" });
    expect(s).toMatch(/node/i);
    expect(s).toMatch(/no network/i);
    expect(s).toMatch(/not.*your files|no access to your files/i);
    expect(s).toContain("console.log(1)");
  });
});
