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
import { buildSystemPrompt } from "./prompt";

let db: ReturnType<typeof openDb>;
let exec: ReturnType<typeof vi.fn>;
let emitted: ServerMsg[];
let build: (script: ProviderEvent[][]) => { agent: Agent; provider: FakeProvider };

const emit = (m: ServerMsg) => emitted.push(m);
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const done: ProviderEvent = { type: "done" };
const count = (table: string) => (db.prepare(`select count(*) c from ${table}`).get() as { c: number }).c;

beforeEach(async () => {
  emitted = [];
  exec = vi.fn(async () => ({ ok: true, output: "should never run", truncated: false }));
  const dir = mkdtempSync(join(tmpdir(), "friend-guest-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 100);
  build = (script) => {
    const provider = new FakeProvider(script);
    const stage = new StageState();
    stage.apply({ cmd: "show", object: { id: "secret-card", type: "card", props: { text: "private" }, placement: "auto" } });
    const agent = new Agent({
      provider,
      policy,
      approvals,
      devices: { exec, hasOnline: () => true, targetName: () => "pc" } as never,
      stage,
      db,
      audit,
      config,
      assistantName: () => auth.assistantName(),
    });
    return { agent, provider };
  };
  // the owner's earlier private conversation
  db.prepare("insert into messages (role, content_json, created_at) values ('user', ?, 1)").run(JSON.stringify([{ type: "text", text: "my bank pin is hidden in the safe" }]));
  db.prepare("insert into messages (role, content_json, created_at) values ('assistant', ?, 2)").run(JSON.stringify([{ type: "text", text: "noted" }]));
});

describe("guest turns", () => {
  it("do not see the owner's conversation history", async () => {
    const { agent, provider } = build([[text("Hello, I can't help with private things."), done]]);
    await agent.runTurn("what did the owner say earlier?", { trust: "guest", emit, ip: "1.1.1.1" });
    const sent = JSON.stringify(provider.calls[0]!.messages);
    expect(sent).toContain("what did the owner say earlier?");
    expect(sent).not.toContain("bank pin");
    expect(provider.calls[0]!.messages).toHaveLength(1);
  });

  it("store nothing: neither the question nor the answer enters the owner's history", async () => {
    const before = count("messages");
    const { agent } = build([[text("Sorry, I can't do that."), done]]);
    await agent.runTurn("unlock the door", { trust: "guest", emit, ip: "1.1.1.1" });
    expect(count("messages")).toBe(before);
  });

  it("leave a dangling owner tool call alone instead of repairing it", async () => {
    db.prepare("insert into messages (role, content_json, created_at) values ('assistant', ?, 3)").run(
      JSON.stringify([{ type: "tool_use", id: "dangling", name: "fs.list", input: {} }]),
    );
    const before = count("messages");
    const { agent } = build([[text("ok"), done]]);
    await agent.runTurn("hi", { trust: "guest", emit, ip: "1.1.1.1" });
    expect(count("messages")).toBe(before);
  });

  it("get no tools and cannot run one even if the model asks", async () => {
    const { agent, provider } = build([[call("1", "shell.run", { command: "dir" }), done], [text("I can't do that."), done]]);
    await agent.runTurn("run a command", { trust: "guest", emit, ip: "1.1.1.1" });
    expect(provider.calls[0]!.tools).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
  });

  it("do not learn what is on the owner's screen", async () => {
    const { agent, provider } = build([[text("hi"), done]]);
    await agent.runTurn("what is on the screen?", { trust: "guest", emit, ip: "1.1.1.1" });
    expect(provider.calls[0]!.system).not.toContain("secret-card");
    expect(provider.calls[0]!.system).toMatch(/unverified/i);
  });

  it("still answer out loud: captions are produced", async () => {
    const { agent } = build([[text("Good evening. I don't know you."), done]]);
    await agent.runTurn("hello", { trust: "guest", emit, ip: "1.1.1.1" });
    expect(emitted.filter((m) => m.type === "caption.delta").map((m) => (m as { text: string }).text).join("")).toContain("don't know you");
    expect(emitted.at(-1)!.type).toBe("status");
  });

  it("do not change what the next owner turn sees", async () => {
    const { agent, provider } = build([[text("guest reply"), done], [text("owner reply"), done]]);
    await agent.runTurn("guest question", { trust: "guest", emit, ip: "1.1.1.1" });
    await agent.runTurn("owner question", { trust: "owner", emit, ip: "1.1.1.1" });
    const ownerSent = JSON.stringify(provider.calls[1]!.messages);
    expect(ownerSent).toContain("owner question");
    expect(ownerSent).toContain("bank pin");
    expect(ownerSent).not.toContain("guest question");
    expect(ownerSent).not.toContain("guest reply");
  });
});

describe("buildSystemPrompt for guests", () => {
  it("states the unverified speaker rules and hides the screen summary", () => {
    const p = buildSystemPrompt("Jarvis", "scene=focus; on screen: secret-card(card)", "guest");
    expect(p).toMatch(/unverified/i);
    expect(p).toMatch(/never reveal/i);
    expect(p).toMatch(/owner will be told|owner is told/i);
    expect(p).not.toContain("secret-card");
    expect(p).toContain("Jarvis");
  });
  it("is unchanged for the owner", () => {
    const p = buildSystemPrompt("Jarvis", "scene=conversation");
    expect(p).toContain("scene=conversation");
    expect(p).not.toMatch(/unverified speaker/i);
  });
});
