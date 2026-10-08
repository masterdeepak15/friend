import { describeCall } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdminApi } from "../admin";
import type { Approvals } from "../approvals";
import { Audit } from "../audit";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import { StageState } from "../stage";
import { Agent, MAX_RESULT_CHARS, type McpApi } from "./loop";
import { buildSystemPrompt, promptParts } from "./prompt";

const done = { type: "done" as const };
const call = (name: string, args: unknown, id = "1") => ({ type: "tool_call" as const, id, name, args });
const spec = { name: "mcp.mail.send_email", description: "[Mail] Sends an email.", inputSchema: { type: "object", properties: { to: { type: "string" } } } };

function build(opts: { script?: ConstructorParameters<typeof FakeProvider>[0]; approve?: boolean; mcpResult?: { text: string; isError: boolean }; withMcp?: boolean; withAdmin?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-conn-"));
  const db = openDb(dir);
  const config = loadConfig(dir);
  const request = vi.fn(async (_r: unknown) => (opts.approve === false ? { approved: false, reason: "denied" } : { approved: true }));
  const mcp: McpApi = {
    toolSpecs: () => [spec],
    has: (n) => n === spec.name,
    call: vi.fn(async () => opts.mcpResult ?? { text: "sent", isError: false }),
    summary: () => "mail (Mail: ready, 1 tools)",
  };
  const admin: AdminApi = { run: vi.fn(async (name) => `ran ${name}`) };
  const provider = new FakeProvider(opts.script ?? [[call("mcp.mail.send_email", { to: "a@b.c" }), done], [done]]);
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
    ...(opts.withMcp === false ? {} : { mcp }),
    ...(opts.withAdmin === false ? {} : { admin }),
  });
  return { agent, provider, request, mcp, admin, db };
}
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit: () => {}, ip: "1.1.1.1" });
const result = (p: FakeProvider) => JSON.stringify(p.calls[1]!.messages.at(-1));

describe("a connector's tools in the agent", () => {
  it("are offered to the model next to the built-in ones, for the owner only", async () => {
    const b = build({ script: [[done], [done]] });
    await b.agent.runTurn("hi", ctx());
    expect(b.provider.calls[0]!.tools.map((t) => t.name)).toContain("mcp.mail.send_email");
    expect(b.provider.calls[0]!.tools.find((t) => t.name === "mcp.mail.send_email")).toMatchObject({ description: "[Mail] Sends an email." });
    const g = build({ script: [[done]] });
    await g.agent.runTurn("hi", ctx("guest"));
    expect(g.provider.calls[0]!.tools).toEqual([]);
  });

  it("always ask the owner first, and run only after approval", async () => {
    const b = build();
    await b.agent.runTurn("mail her", ctx());
    expect(b.request).toHaveBeenCalledTimes(1);
    expect(b.request.mock.calls[0]![0]).toMatchObject({ tool: "mcp.mail.send_email", tier: "T2" });
    expect(b.mcp.call).toHaveBeenCalledWith("mcp.mail.send_email", { to: "a@b.c" }, expect.anything());
    expect(result(b.provider)).toContain("sent");
  });

  it("do nothing when the owner says no", async () => {
    const b = build({ approve: false });
    await b.agent.runTurn("mail her", ctx());
    expect(b.mcp.call).not.toHaveBeenCalled();
    expect(result(b.provider)).toMatch(/did not approve/);
  });

  it("pass on an error result as an error, and cut a huge result", async () => {
    const failing = build({ mcpResult: { text: "mailbox is locked", isError: true } });
    await failing.agent.runTurn("x", ctx());
    expect(result(failing.provider)).toMatch(/mailbox is locked/);
    expect(result(failing.provider)).toMatch(/"isError":true/);
    const big = build({ mcpResult: { text: "x".repeat(MAX_RESULT_CHARS + 500), isError: false } });
    await big.agent.runTurn("x", ctx());
    expect(result(big.provider)).toContain("[output truncated]");
  });

  it("are logged without their content beyond a short clip", async () => {
    const b = build({ script: [[call("mcp.mail.send_email", { to: "a@b.c", body: "z".repeat(1000) }), done], [done]] });
    await b.agent.runTurn("x", ctx());
    const row = b.db.prepare("select detail_json from audit_log where kind = 'tool.call'").get() as { detail_json: string };
    expect(row.detail_json).toContain("mcp.mail.send_email");
    expect(row.detail_json.length).toBeLessThan(600);
  });

  it("a name that is not a connector's tool is an unknown tool", async () => {
    const b = build({ script: [[call("mcp.mail.nothing", {}), done], [done]] });
    await b.agent.runTurn("x", ctx());
    expect(b.mcp.call).not.toHaveBeenCalled();
    expect(result(b.provider)).toMatch(/Unknown tool/);
  });

  it("are not available to a guest who somehow names one", async () => {
    const b = build();
    await b.agent.runTurn("mail her", ctx("guest"));
    expect(b.mcp.call).not.toHaveBeenCalled();
  });
});

describe("the connector and plugin management tools", () => {
  it("run through the admin layer when approved, and list without asking", async () => {
    const b = build({ script: [[call("connectors.list", {}), done], [done]] });
    await b.agent.runTurn("what is connected?", ctx());
    expect(b.request).not.toHaveBeenCalled();
    expect(b.admin.run).toHaveBeenCalledWith("connectors.list", {});
    expect(result(b.provider)).toContain("ran connectors.list");
  });

  it("need the PIN to add or switch on a connector or to create or switch on a plugin", async () => {
    for (const [name, args] of [
      ["connectors.add", { id: "m", name: "M", kind: "stdio", command: "x" }],
      ["connectors.enable", { id: "m" }],
      ["plugins.create", { id: "p", name: "P" }],
      ["plugins.enable", { id: "p" }],
    ] as const) {
      const b = build({ script: [[call(name, args), done], [done]] });
      await b.agent.runTurn("x", ctx());
      expect(b.request.mock.calls[0]![0], name).toMatchObject({ tool: name, tier: "T3", needsPin: true });
      expect(b.admin.run).toHaveBeenCalledWith(name, args);
    }
  });

  it("ask (without the PIN) to remove, and just do the harmless ones", async () => {
    const remove = build({ script: [[call("connectors.remove", { id: "m" }), done], [done]] });
    await remove.agent.runTurn("x", ctx());
    expect(remove.request.mock.calls[0]![0]).toMatchObject({ tier: "T2", needsPin: false });
    for (const name of ["connectors.disable", "connectors.reload", "plugins.reload", "plugins.disable"]) {
      const b = build({ script: [[call(name, { id: "m" }), done], [done]] });
      await b.agent.runTurn("x", ctx());
      expect(b.request, name).not.toHaveBeenCalled();
      expect(b.admin.run).toHaveBeenCalled();
    }
  });

  it("change nothing when the owner does not approve", async () => {
    const b = build({ approve: false, script: [[call("plugins.create", { id: "p", name: "P" }), done], [done]] });
    await b.agent.runTurn("x", ctx());
    expect(b.admin.run).not.toHaveBeenCalled();
  });

  it("tell the model plainly when the admin layer refuses or is missing", async () => {
    const refusing = build({ script: [[call("connectors.enable", { id: "m" }), done], [done]] });
    (refusing.admin.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("There is no connector \"m\"."));
    await refusing.agent.runTurn("x", ctx());
    expect(result(refusing.provider)).toMatch(/no connector/);
    const none = build({ withAdmin: false, script: [[call("connectors.list", {}), done], [done]] });
    await none.agent.runTurn("x", ctx());
    expect(result(none.provider)).toMatch(/not available/);
  });

  it("log only the id, never what a plugin contains", async () => {
    const b = build({ script: [[call("plugins.create", { id: "p", name: "P", skills: [{ name: "s", description: "d", text: "TOP-SECRET-TEXT" }] }), done], [done]] });
    await b.agent.runTurn("x", ctx());
    const row = b.db.prepare("select detail_json from audit_log where kind = 'tool.call'").get() as { detail_json: string };
    expect(row.detail_json).not.toContain("TOP-SECRET-TEXT");
  });
});

describe("what the approval card shows", () => {
  it("is the exact program that will run, or the address", () => {
    expect(describeCall("connectors.add", { id: "m", name: "Mail", kind: "stdio", command: "npx", args: ["-y", "some-mail-server"] })).toBe('Add the connector "Mail" (m) and switch it on. It will start this program on your PC (no shell): npx -y some-mail-server');
    expect(describeCall("connectors.add", { id: "w", name: "Web", kind: "http", url: "https://x.example/mcp" })).toContain("connect to https://x.example/mcp");
  });
  it("is everything a new plugin contains, not a shortened version", () => {
    const text = describeCall("plugins.create", { id: "p", name: "P", skills: [{ name: "s", description: "d", text: "LONG ".repeat(500) }], tools: [{ name: "t", description: "d", language: "shell", code: "echo hello-from-tool" }] });
    expect(text).toContain("LONG ".repeat(500));
    expect(text).toContain("echo hello-from-tool");
    expect(text).toMatch(/SKILL s/);
    expect(text).toMatch(/TOOL t \(shell, runs in the sandbox, asks you every time\)/);
  });
});

describe("the prompt", () => {
  it("says which connectors there are in the changing part, and keeps the rules in the stable part", () => {
    const { system, context } = promptParts("Jarvis", "scene=x", "owner", undefined, undefined, undefined, "mail (Mail: ready, 1 tools)");
    expect(context).toContain("Connectors: mail (Mail: ready, 1 tools)");
    expect(system).not.toContain("mail (Mail");
    expect(system).toMatch(/untrusted data/);
    expect(system).toMatch(/never send an email/i);
    expect(system).toMatch(/plugins\.create only after the owner agrees/);
    expect(system).toMatch(/never give a connector a secret/i);
  });
  it("tells a guest nothing about connectors", () => {
    expect(buildSystemPrompt("Jarvis", "scene=x", "guest", undefined, undefined, undefined, "mail (Mail: ready)")).not.toMatch(/mail \(Mail|Connectors/);
  });
});
