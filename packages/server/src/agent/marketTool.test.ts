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
let run: ReturnType<typeof vi.fn<(name: string, args: unknown) => Promise<{ ok: boolean; text: string }>>>;
let build: (provider: FakeProvider, o?: { market?: boolean; web?: boolean }) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? pin : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  run = vi.fn(async () => ({ ok: true, text: "RELIANCE 1190.00 INR, +0.46%" }));
  const dir = mkdtempSync(join(tmpdir(), "friend-check-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  const config = loadConfig(dir);
  policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider, o = {}) =>
    new Agent({
      provider,
      policy,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      ...(o.market === false ? {} : { market: { run } }),
      ...(o.web === false ? {} : { web: { enabled: () => true, run: vi.fn() } }),
      approvals,
    });
});

describe("market tools in the agent loop", () => {
  it("runs market.get without asking the owner and hands the model the text", async () => {
    const provider = new FakeProvider([[call("c1", "market.get", { kind: "quote", symbol: "RELIANCE" }), done], [text("It is 1190."), done]]);
    await build(provider).runTurn("price of reliance", ctx);
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(["market.get", { kind: "quote", symbol: "RELIANCE" }]);
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toContain("1190.00 INR");
  });

  it("offers the tools only while the web is on and the market is wired", async () => {
    const names = async (o: { market?: boolean; web?: boolean }) => {
      const provider = new FakeProvider([[text("ok"), done]]);
      await build(provider, o).runTurn("hi", ctx);
      return provider.calls[0]!.tools.map((t: { name: string }) => t.name);
    };
    expect(await names({})).toEqual(expect.arrayContaining(["market.get", "market.replay"]));
    expect(await names({ web: false })).not.toContain("market.get");
    expect(await names({ market: false })).not.toContain("market.replay");
  });

  it("tells the model when the feed failed", async () => {
    run.mockResolvedValueOnce({ ok: false, text: "The site answered with an error (500)." });
    const provider = new FakeProvider([[call("c1", "market.get", { kind: "quote", symbol: "TCS" }), done], [text("Could not."), done]]);
    await build(provider).runTurn("tcs", ctx);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toContain("error (500)");
  });
});