import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const pin = "123456";
const INFO = "platform: win32\nhost: PC\ncpu: Intel x12\ncpu load: 56%\nmemory: 5.0 GB free of 23.6 GB\ndisk: 27.5 GB free of 100 GB (C:)\nuptime: 12.5 hours";

let emitted: ServerMsg[];
let approvals: Approvals;
let stage: StageState;
let build: (provider: FakeProvider) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision: "approve", pin: m.needsPin ? pin : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const lastTool = (p: FakeProvider, n = 1) => JSON.stringify(p.calls[n]!.messages.at(-1));

beforeEach(async () => {
  emitted = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-instruments-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  stage = new StageState();
  build = (provider) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(async () => ({ ok: true, output: INFO, truncated: false })), hasOnline: () => true, targetName: () => "pc" } as never,
      stage,
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
    });
});

describe("the live instruments and the scene", () => {
  it("system.info draws its gauge cards when the system instrument is not up", async () => {
    const p = new FakeProvider([[call("1", "system.info", {}), done], [text("ok"), done]]);
    await build(p).runTurn("how is my pc", ctx);
    expect(stage.snapshot().objects.length).toBeGreaterThan(0);
    expect(lastTool(p)).toMatch(/gauges are already on the screen/);
  });

  it("with the system instrument up, it draws no cards: the live instrument is the picture", async () => {
    const p = new FakeProvider([[call("1", "stage.widget", { show: ["system"] }), call("2", "system.info", {}), done], [text("ok"), done]]);
    await build(p).runTurn("show my system", ctx);
    expect(stage.snapshot().widgets).toEqual(["system"]);
    expect(stage.snapshot().objects).toEqual([]);
    expect(lastTool(p)).toMatch(/system instrument is already on the screen/);
  });

  it("a new scene replaces the pictures but not the instruments that were brought up", async () => {
    const p = new FakeProvider([[call("1", "stage.widget", { show: ["voice", "network"] }), call("2", "system.info", {}), done], [text("ok"), done]]);
    await build(p).runTurn("show my voice and my pc", ctx);
    expect(stage.snapshot().widgets).toEqual(["voice", "network"]);
    expect(stage.snapshot().objects.length).toBeGreaterThan(0);
  });

  it("clearing the screen puts the instruments away too, and the screens are told", async () => {
    const p = new FakeProvider([[call("1", "stage.widget", { show: ["radar"] }), call("2", "stage.clear", {}), done], [text("ok"), done]]);
    await build(p).runTurn("show devices then clear", ctx);
    expect(stage.snapshot().widgets).toEqual([]);
    const cmds = emitted.filter((m) => m.type === "stage").map((m) => (m as { command: { cmd: string } }).command.cmd);
    expect(cmds).toEqual(expect.arrayContaining(["widget", "clear"]));
  });

  it("needs no approval to bring up or put away", async () => {
    const p = new FakeProvider([[call("1", "stage.widget", { show: ["tickets"] }), call("2", "stage.widget", { reset: true }), done], [text("ok"), done]]);
    await build(p).runTurn("tickets", ctx);
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
  });
});
