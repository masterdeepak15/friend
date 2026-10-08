import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import { buildSystemPrompt, promptParts } from "./prompt";

const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

describe("promptParts", () => {
  const owner = promptParts("Jarvis", "scene=focus; on screen: a(card)", "owner", ["#1 likes tea"], "2026-10-08T12:00:00+05:30", [
    { plugin: "p", name: "s", description: "d" },
  ]);

  it("keeps everything that changes from request to request out of the stable part", () => {
    expect(owner.system).not.toContain("Current time");
    expect(owner.system).not.toContain("2026-10-08T12:00:00");
    expect(owner.system).not.toContain("scene=focus");
    expect(owner.system).not.toContain("a(card)");
  });

  it("puts the clock and the screen in the context, and keeps the notes and skills in the stable part", () => {
    expect(owner.context).toContain("Current time: 2026-10-08T12:00:00+05:30");
    expect(owner.context).toContain("scene=focus; on screen: a(card)");
    expect(owner.system).toContain("#1 likes tea");
    expect(owner.system).toContain("p/s: d");
    expect(owner.system).toMatch(/task\.add/); // how to use reminders is guidance, so it does not change
  });

  it("is the same stable text for two different moments", () => {
    const later = promptParts("Jarvis", "scene=ambient; on screen: nothing", "owner", ["#1 likes tea"], "2026-10-08T12:01:00+05:30", [
      { plugin: "p", name: "s", description: "d" },
    ]);
    expect(later.system).toBe(owner.system);
    expect(later.context).not.toBe(owner.context);
  });

  it("gives a guest no context at all", () => {
    const guest = promptParts("Jarvis", "scene=focus; on screen: SCREEN-TOKEN(card)", "guest", ["#1 NOTE-TOKEN"], "2026-10-08T12:00:00+05:30");
    expect(guest.context).toBe("");
    expect(guest.system).not.toContain("SCREEN-TOKEN");
    expect(guest.system).not.toContain("NOTE-TOKEN");
  });

  it("buildSystemPrompt still returns the whole prompt in one piece", () => {
    const whole = buildSystemPrompt("Jarvis", "scene=focus; on screen: a(card)", "owner", ["#1 likes tea"], "2026-10-08T12:00:00+05:30");
    expect(whole).toContain("#1 likes tea");
    expect(whole).toContain("Current time: 2026-10-08T12:00:00+05:30");
    expect(whole).toContain("scene=focus; on screen: a(card)");
  });
});

describe("what the model is sent", () => {
  async function agentWith(provider: FakeProvider) {
    const dir = mkdtempSync(join(tmpdir(), "friend-prefix-"));
    const db = openDb(dir);
    const audit = new Audit(db);
    const auth = new Auth(db, audit);
    await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
    const config = loadConfig(dir);
    const policy = new PolicyEngine(db, config);
    const stage = new StageState();
    const agent = new Agent({
      provider,
      policy,
      approvals: new Approvals({ auth, policy, audit, db }, 100),
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage,
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
    });
    return { agent, stage };
  }
  const ctx = { trust: "owner" as const, emit: (_m: ServerMsg) => {}, ip: "1.1.1.1" };

  it("sends the same system text and the same tools on every call, however the screen and clock change", async () => {
    const p = new FakeProvider([
      [call("1", "stage.show", { object: { id: "a", type: "card", props: { text: "hi" }, placement: "center" } }), done],
      [text("one"), done],
      [text("two"), done],
    ]);
    const { agent } = await agentWith(p);
    await agent.runTurn("show a card", ctx);
    await new Promise((r) => setTimeout(r, 1100)); // the clock moves on
    await agent.runTurn("anything else?", ctx);
    expect(p.calls).toHaveLength(3);
    // the screen changed between the first and second call, and the clock between the second and third
    expect(p.calls[0]!.context).toContain("the stage is empty");
    expect(p.calls[1]!.context).toContain("a (card");
    expect(p.calls[1]!.context).not.toBe(p.calls[2]!.context);
    for (const c of p.calls.slice(1)) {
      expect(c.system).toBe(p.calls[0]!.system);
      expect(c.tools).toEqual(p.calls[0]!.tools);
    }
  });

  it("sends a guest no context and the guest prompt only", async () => {
    const p = new FakeProvider([[text("hi"), done]]);
    const { agent } = await agentWith(p);
    await agent.runTurn("hello", { ...ctx, trust: "guest" });
    expect(p.calls[0]!.context ?? "").toBe("");
  });
});
