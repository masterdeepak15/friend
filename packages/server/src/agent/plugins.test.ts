import type { ServerMsg } from "@friend/protocol";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import type { CodeBox, RunResult } from "../codebox";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { Plugins } from "../plugins";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const TOOL = "plugin.unit-converter.convert";

let emitted: ServerMsg[];
let decision: "approve" | "deny";
let approvals: Approvals;
let plugins: Plugins;
let run: ReturnType<typeof vi.fn<CodeBox["run"]>>;
let policy: PolicyEngine;
let build: (provider: FakeProvider, opts?: { box?: boolean; plugins?: boolean }) => Agent;
const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? "123456" : undefined }, "9.9.9.9");
};
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit, ip: "9.9.9.9" });
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls[1]!.messages.at(-1));
const ok = (r: Partial<Extract<RunResult, { ok: true }>> = {}): RunResult => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r });

function pluginFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "friend-agentplug-"));
  const files: Record<string, string> = {
    "plugin.json": JSON.stringify({
      id: "unit-converter",
      name: "Unit converter",
      version: "1.0.0",
      description: "Converts units",
      skills: [{ name: "standup", description: "Write a stand-up update", file: "skills/standup.md" }],
      tools: [
        {
          name: "convert",
          description: "Convert a value between units",
          language: "python",
          file: "tools/convert.py",
          input: { value: { type: "number" }, from: { type: "string" }, to: { type: "string" } },
          required: ["value", "from", "to"],
        },
      ],
    }),
    "skills/standup.md": "Ask what was done, what is next, and what blocks.",
    "tools/convert.py": "import json; a = json.load(open('/work/args.json')); print(a['value'])",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  run = vi.fn<CodeBox["run"]>(async () => ok({ stdout: "3.1\n" }));
  const dir = mkdtempSync(join(tmpdir(), "friend-agentplugdb-"));
  const db = openDb(dir);
  plugins = new Plugins(db, join(dir, "plugins"));
  expect(plugins.install(pluginFolder()).ok).toBe(true);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 300);
  build = (provider, o = {}) =>
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
      ...(o.box === false ? {} : { code: { run } }),
      ...(o.plugins === false ? {} : { plugins }),
    });
});

describe("plugin tools", () => {
  it("are offered to the model with their declared input, and only while the plugin is on", async () => {
    const p = new FakeProvider([[text("hi"), done], [text("hi"), done]]);
    await build(p).runTurn("hello", ctx());
    const spec = p.calls[0]!.tools.find((t) => t.name === TOOL)!;
    expect(spec.description).toContain("[Plugin Unit converter]");
    expect(spec.inputSchema).toMatchObject({ type: "object", required: ["value", "from", "to"], additionalProperties: false });
    plugins.setEnabled("unit-converter", false);
    await build(p).runTurn("again", ctx());
    expect(p.calls[1]!.tools.some((t) => t.name === TOOL)).toBe(false);
  });

  it("ask the owner first, then run in the sandbox with the arguments as /work/args.json", async () => {
    const args = { value: 2, from: "km", to: "mi" };
    const p = new FakeProvider([[call("1", TOOL, args), done], [text("1.2 miles"), done]]);
    await build(p).runTurn("2 km in miles", ctx());
    const card = emitted.find((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>;
    expect(card).toMatchObject({ tool: TOOL, tier: "T2", needsPin: false });
    expect(card.summary).toContain(TOOL);
    expect(card.summary).toContain('"value":2');
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0]![0];
    expect(input).toMatchObject({ language: "python", files: { "args.json": JSON.stringify(args) } });
    expect(input.code).toContain("args.json");
    expect(lastTool(p)).toContain("3.1");
  });

  it("do not run when the owner says no", async () => {
    decision = "deny";
    const p = new FakeProvider([[call("1", TOOL, { value: 1, from: "a", to: "b" }), done], [text("ok"), done]]);
    await build(p).runTurn("convert", ctx());
    expect(run).not.toHaveBeenCalled();
    expect(lastTool(p)).toMatch(/did not approve/i);
  });

  it("refuse bad arguments before any approval card is drawn", async () => {
    const p = new FakeProvider([
      [call("1", TOOL, { value: "five", from: "km", to: "mi" }), call("2", TOOL, { value: 1, from: "km", to: "mi", sneaky: true }), done],
      [text("ok"), done],
    ]);
    await build(p).runTurn("convert", ctx());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(lastTool(p)).toMatch(/Invalid arguments/);
  });

  it("report a failing program, a timeout and a docker problem as tool errors the model can read", async () => {
    run.mockResolvedValueOnce(ok({ exitCode: 2, stderr: "KeyError: 'value'" }));
    run.mockResolvedValueOnce(ok({ exitCode: 137, timedOut: true }));
    run.mockResolvedValueOnce({ ok: false, error: "Docker is not running. Start Docker Desktop and try again." });
    const a = { value: 1, from: "a", to: "b" };
    const p = new FakeProvider([[call("1", TOOL, a), call("2", TOOL, a), call("3", TOOL, a), done], [text("ok"), done]]);
    await build(p).runTurn("convert", ctx());
    const out = JSON.parse(lastTool(p)).content as { content: string; isError: boolean }[];
    expect(out.map((o) => o.isError)).toEqual([true, true, true]);
    expect(out[0]!.content).toMatch(/exit code 2/);
    expect(out[0]!.content).toContain("KeyError");
    expect(out[1]!.content).toMatch(/time limit/i);
    expect(out[2]!.content).toContain("Docker is not running");
  });

  it("need the code sandbox, and say so without asking", async () => {
    const p = new FakeProvider([[call("1", TOOL, { value: 1, from: "a", to: "b" }), done], [text("ok"), done]]);
    await build(p, { box: false }).runTurn("convert", ctx());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(lastTool(p)).toContain("Running code is not available.");
  });

  it("never reach a guest", async () => {
    const p = new FakeProvider([[call("1", TOOL, { value: 1, from: "a", to: "b" }), done], [text("no"), done]]);
    await build(p).runTurn("convert", ctx("guest"));
    expect(p.calls[0]!.tools).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
  });
});

describe("plugin skills", () => {
  it("are listed in the prompt, labeled as plugin text that cannot override the owner's rules", async () => {
    const p = new FakeProvider([[text("hi"), done]]);
    await build(p).runTurn("hello", ctx());
    const system = p.calls[0]!.system;
    expect(system).toContain("unit-converter/standup: Write a stand-up update");
    expect(system).toMatch(/skill\.use/);
    expect(system).toMatch(/cannot override/i);
  });

  it("are loaded in full with skill.use", async () => {
    const p = new FakeProvider([[call("1", "skill.use", { plugin: "unit-converter", name: "standup" }), done], [text("ok"), done]]);
    await build(p).runTurn("write my standup", ctx());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(lastTool(p)).toContain("Ask what was done, what is next, and what blocks.");
  });

  it("report an unknown or switched-off skill in words", async () => {
    plugins.setEnabled("unit-converter", false);
    const p = new FakeProvider([[call("1", "skill.use", { plugin: "unit-converter", name: "standup" }), call("2", "skill.use", { plugin: "x", name: "y" }), done], [text("ok"), done]]);
    await build(p).runTurn("go", ctx());
    expect(JSON.parse(lastTool(p)).content.map((c: { content: string }) => c.content)).toEqual(["Error: No such skill.", "Error: No such skill."]);
    expect(p.calls[0]!.system).not.toContain("unit-converter/standup");
  });

  it("are not shown to a guest", async () => {
    const p = new FakeProvider([[text("hi"), done]]);
    await build(p).runTurn("hello", ctx("guest"));
    expect(p.calls[0]!.system).not.toContain("standup");
  });

  it("without a plugin store the prompt and the tool still behave", async () => {
    const p = new FakeProvider([[call("1", "skill.use", { plugin: "a", name: "b" }), done], [text("ok"), done]]);
    await build(p, { plugins: false }).runTurn("go", ctx());
    expect(p.calls[0]!.system).not.toMatch(/Skills from plugins/);
    expect(lastTool(p)).toContain("No such skill.");
  });
});
