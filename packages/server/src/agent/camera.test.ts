import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "@friend/protocol";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import type { CameraBroker } from "../camera";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const PICTURE = "QUJDREVGRw==";
const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const pin = "123456";

let emitted: ServerMsg[];
let decision: "approve" | "approve_always" | "deny";
let approvals: Approvals;
let policy: PolicyEngine;
let db: ReturnType<typeof openDb>;
let snap: ReturnType<typeof vi.fn<CameraBroker["request"]>>;
let build: (provider: FakeProvider & { vision?: boolean }, withCamera?: boolean) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? pin : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const seeing = (script: ProviderEvent[][]) => Object.assign(new FakeProvider(script), { vision: true });

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  snap = vi.fn<CameraBroker["request"]>(async () => ({ ok: true, mime: "image/jpeg", data: PICTURE }));
  const dir = mkdtempSync(join(tmpdir(), "friend-cam-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  const config = loadConfig(dir);
  policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider, withCamera = true) =>
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
      ...(withCamera ? { camera: { request: snap } } : {}),
    });
});

describe("camera.snap in the agent loop", () => {
  it("asks the owner first, then hands the model the picture on the tool message", async () => {
    const provider = seeing([[call("c1", "camera.snap"), done], [text("It is a mug."), done]]);
    await build(provider).runTurn("what is this?", ctx);
    const approval = emitted.find((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>;
    expect(approval).toMatchObject({ tool: "camera.snap", tier: "T2", needsPin: false });
    expect(approval.summary).toMatch(/picture/i);
    expect(snap).toHaveBeenCalledTimes(1);
    const toolMsg = provider.calls[1]!.messages.at(-1)!;
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content).toEqual([
      { type: "tool_result", toolUseId: "c1", content: "Picture taken.", isError: false },
      { type: "image", mime: "image/jpeg", data: PICTURE },
    ]);
  });

  it("keeps the picture out of the stored history", async () => {
    await build(seeing([[call("c1", "camera.snap"), done], [text("A mug."), done]])).runTurn("look", ctx);
    const stored = JSON.stringify(db.prepare("select content_json from messages").all());
    expect(stored).not.toContain(PICTURE);
    expect(stored).toContain("[camera picture, not kept]");
  });

  it("does not take a picture when the owner denies", async () => {
    decision = "deny";
    const provider = seeing([[call("c1", "camera.snap"), done], [text("Understood."), done]]);
    await build(provider).runTurn("look", ctx);
    expect(snap).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/did not approve/i);
  });

  it("explains a model that cannot see, without asking the owner", async () => {
    const provider = new FakeProvider([[call("c1", "camera.snap"), done], [text("Sorry."), done]]);
    await build(provider).runTurn("look", ctx);
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(snap).not.toHaveBeenCalled();
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/cannot look at pictures/i);
  });

  it("reports the browser's reason when no picture comes back", async () => {
    snap.mockResolvedValueOnce({ ok: false, error: "The owner has the camera switched off." });
    const provider = seeing([[call("c1", "camera.snap"), done], [text("It is off."), done]]);
    await build(provider).runTurn("look", ctx);
    const last = provider.calls[1]!.messages.at(-1)!;
    expect(last.content).toEqual([{ type: "tool_result", toolUseId: "c1", content: "Error: The owner has the camera switched off.", isError: true }]);
  });

  it("says so when there is no camera support in this server", async () => {
    const provider = seeing([[call("c1", "camera.snap"), done], [text("No."), done]]);
    await build(provider, false).runTurn("look", ctx);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/camera is not available/i);
  });

  it("never turns 'always allow' into a standing rule, and asks again next time", async () => {
    decision = "approve_always";
    const provider = seeing([[call("c1", "camera.snap"), done], [call("c2", "camera.snap"), done], [text("Two."), done]]);
    await build(provider).runTurn("look twice", ctx);
    expect(emitted.filter((m) => m.type === "approval.request")).toHaveLength(2);
    expect(policy.listRules().filter((r) => r.tool === "camera.snap")).toEqual([]);
  });

  it("is refused for a guest, who has no tools", async () => {
    const provider = seeing([[call("c1", "camera.snap"), done], [text("No."), done]]);
    await build(provider).runTurn("look", { ...ctx, trust: "guest" });
    expect(snap).not.toHaveBeenCalled();
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
  });
});

describe("camera.snap policy", () => {
  it("always asks, even if a rule was somehow stored", () => {
    policy.addRule("camera.snap", { argEquals: {} });
    expect(policy.decide({ tool: "camera.snap", baseTier: "T2", args: {}, trust: "owner", insideRoots: true })).toBe("ask");
  });
});
