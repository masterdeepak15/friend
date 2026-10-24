import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "@friend/protocol";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import type { ScreenCheck } from "../screenCheck";
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

let emitted: ServerMsg[];
let decision: "approve" | "approve_always" | "deny";
let approvals: Approvals;
let policy: PolicyEngine;
let db: ReturnType<typeof openDb>;
let ask: ReturnType<typeof vi.fn<ScreenCheck["request"]>>;
let build: (provider: FakeProvider, withCheck?: boolean) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? pin : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  ask = vi.fn<ScreenCheck["request"]>(async () => ({ ok: true, lines: ["card a covers the voice panel", "chart b is cut off"] }));
  const dir = mkdtempSync(join(tmpdir(), "friend-check-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  const config = loadConfig(dir);
  policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider, withCheck = true) =>
    new Agent({
      provider,
      policy,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      ...(withCheck ? { screenCheck: { request: ask } } : {}),
      approvals,
    });
});

describe("stage.check in the agent loop", () => {
  it("hands the model what the screen reported, without asking the owner for anything", async () => {
    const provider = new FakeProvider([[call("c1", "stage.check"), done], [text("Moved it."), done]]);
    await build(provider).runTurn("draw the report", ctx);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    const toolMsg = JSON.stringify(provider.calls[1]!.messages.at(-1));
    expect(toolMsg).toContain("covers the voice panel");
    expect(toolMsg).toContain("is cut off");
  });

  it("tells the model when no screen answered", async () => {
    ask.mockResolvedValueOnce({ ok: false, error: "The screen did not answer in time." });
    const provider = new FakeProvider([[call("c1", "stage.check"), done], [text("Could not check."), done]]);
    await build(provider).runTurn("draw", ctx);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/did not answer/i);
  });

  it("is reported as unavailable when the server has no screen check", async () => {
    const provider = new FakeProvider([[call("c1", "stage.check"), done], [text("Sorry."), done]]);
    await build(provider, false).runTurn("draw", ctx);
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/not available/i);
  });
});
