import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Approvals } from "../approvals";
import { Audit } from "../audit";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import { refuseForAgent } from "../settings";
import { StageState } from "../stage";
import { Agent, type AgentSettings } from "./loop";

const done = { type: "done" as const };
const call = (name: string, args: unknown, id = "1") => ({ type: "tool_call" as const, id, name, args });

function build(opts: { approve?: boolean; withSettings?: boolean; provider?: FakeProvider } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-aiset-"));
  const db = openDb(dir);
  const config = loadConfig(dir);
  const request = vi.fn(async (_req: unknown) => (opts.approve === false ? { approved: false, reason: "denied" } : { approved: true }));
  const settings: AgentSettings = {
    get: vi.fn(() => ({ provider: "claude-code" })),
    set: vi.fn(async () => "Saved."),
    setView: vi.fn((v) => `The view is now ${v}.`),
  };
  const provider = opts.provider ?? new FakeProvider([[call("settings.set", { settings: { claudeCode: { model: "haiku" } } }), done], [done]]);
  const agent = new Agent({
    provider,
    policy: new PolicyEngine(db, config),
    approvals: { request } as unknown as Approvals,
    devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
    stage: new StageState(),
    db,
    audit: new Audit(db),
    config,
    assistantName: () => "Jarvis",
    ...(opts.withSettings === false ? {} : { settings }),
  });
  return { agent, settings, request, provider, db };
}
const ctx = (trust: "owner" | "guest" = "owner", emit: (m: ServerMsg) => void = () => {}) => ({ trust, emit, ip: "1.1.1.1" });
const toolResult = (p: FakeProvider) => JSON.stringify(p.calls[1]!.messages.at(-1));

describe("the AI and the settings", () => {
  it("reads the settings without asking", async () => {
    const b = build({ provider: new FakeProvider([[call("settings.get", {}), done], [done]]) });
    await b.agent.runTurn("what are my settings?", ctx());
    expect(b.request).not.toHaveBeenCalled();
    expect(toolResult(b.provider as FakeProvider)).toContain("claude-code");
  });

  it("needs the owner's PIN to change them, and then changes them", async () => {
    const b = build();
    await b.agent.runTurn("use haiku", ctx());
    expect(b.request).toHaveBeenCalledTimes(1);
    expect(b.request.mock.calls[0]![0]).toMatchObject({ tool: "settings.set", tier: "T3", needsPin: true });
    expect(b.settings.set).toHaveBeenCalledWith({ claudeCode: { model: "haiku" } });
    expect(toolResult(b.provider as FakeProvider)).toContain("Saved.");
  });

  it("changes nothing when the owner does not approve", async () => {
    const b = build({ approve: false });
    await b.agent.runTurn("use haiku", ctx());
    expect(b.settings.set).not.toHaveBeenCalled();
    expect(toolResult(b.provider as FakeProvider)).toMatch(/did not approve/);
  });

  it("changes the view without a PIN card", async () => {
    const b = build({ provider: new FakeProvider([[call("view.set", { view: "workspace" }), done], [done]]) });
    await b.agent.runTurn("show me everything", ctx());
    expect(b.request).not.toHaveBeenCalled();
    expect(b.settings.setView).toHaveBeenCalledWith("workspace");
  });

  it("refuses a view that does not exist", async () => {
    const b = build({ provider: new FakeProvider([[call("view.set", { view: "huge" }), done], [done]]) });
    await b.agent.runTurn("x", ctx());
    expect(b.settings.setView).not.toHaveBeenCalled();
    expect(toolResult(b.provider as FakeProvider)).toMatch(/Invalid arguments/);
  });

  it("says so when settings are not available, and passes on a refusal in plain words", async () => {
    const none = build({ withSettings: false });
    await none.agent.runTurn("x", ctx());
    expect(toolResult(none.provider as FakeProvider)).toMatch(/not available/);
    const refused = build();
    (refused.settings.set as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("The API key can only be changed by the owner on the settings screen."));
    await refused.agent.runTurn("x", ctx());
    expect(toolResult(refused.provider as FakeProvider)).toMatch(/API key can only be changed/);
  });

  it("writes only the names of the changed fields to the audit log", async () => {
    const b = build();
    await b.agent.runTurn("use haiku", ctx());
    const row = b.db.prepare("select detail_json from audit_log where kind = 'tool.call'").get() as { detail_json: string };
    expect(row.detail_json).toContain("claudeCode");
    expect(row.detail_json).not.toContain("haiku");
  });
});

describe("what the AI may not change", () => {
  it("never the API key or the program that gets started", () => {
    expect(() => refuseForAgent({ apiKey: "x" })).toThrow(/API key/);
    expect(() => refuseForAgent({ claudeCode: { command: "evil.exe" } })).toThrow(/command/);
    expect(() => refuseForAgent({ claudeCode: { model: "haiku" }, voice: { speakTyped: false } })).not.toThrow();
  });
});

describe("Agent.whenIdle", () => {
  it("runs a job at once when nothing is going on", () => {
    const job = vi.fn();
    build().agent.whenIdle(job);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("holds a job until the running request is finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      id: "slow",
      async *stream() {
        await gate;
        yield { type: "text_delta" as const, text: "ok" };
        yield done;
      },
    };
    const b = build();
    const agent = new Agent({ ...(b.agent as unknown as { deps: ConstructorParameters<typeof Agent>[0] }).deps, provider: slow });
    const job = vi.fn();
    const turn = agent.runTurn("hi", ctx());
    await new Promise((r) => setTimeout(r, 20));
    agent.whenIdle(job);
    expect(job).not.toHaveBeenCalled();
    release();
    await turn;
    expect(job).toHaveBeenCalledTimes(1);
  });
});
