import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, type AgentDeps } from "../agent/loop";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb, type Db } from "../db";
import { existsSync } from "node:fs";
import { Memory } from "../memory";
import { MemoryTree } from "../memory/tree";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Crew, grantAllows } from "./crew";
import { CrewStore } from "./store";

const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const ip = "9.9.9.9";

let dir: string;
let db: Db;
let approvals: Approvals;
let build: (provider: FakeProvider, done?: (w: string, r: { ok: boolean; text: string }) => void) => { agent: Agent; crew: Crew; deps: AgentDeps };
let emitted: ServerMsg[];

beforeEach(async () => {
  emitted = [];
  dir = mkdtempSync(join(tmpdir(), "friend-crew-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Maya" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 200);
  build = (provider, done) => {
    let base!: AgentDeps;
    const crew = new Crew({ store: new CrewStore(db), dataDir: dir, base: () => base, assistantName: () => "Maya", audit, ...(done ? { done } : {}) });
    base = {
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(async () => ({ ok: true, output: "written", truncated: false })), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Maya",
      memory: new Memory(db),
      crew,
    };
    return { agent: new Agent(base), crew, deps: base };
  };
});

const approveCards = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") approvals.respond({ id: m.id, decision: "approve" }, ip);
};
const owner = () => ({ trust: "owner" as const, emit: approveCards, ip });
const names = (p: FakeProvider, n = 0) => p.calls[n]!.tools.map((t) => t.name);

describe("what a worker may use", () => {
  it("allows names and prefixes, always has its own notes, and never runs the house", () => {
    expect(grantAllows(["web.*", "file.present"], "web.search")).toBe(true);
    expect(grantAllows(["web.*", "file.present"], "file.present")).toBe(true);
    expect(grantAllows(["web.*"], "shell.run")).toBe(false);
    expect(grantAllows([], "memory.remember")).toBe(true);
    expect(grantAllows(["*"], "crew.hire")).toBe(false);
    expect(grantAllows(["*"], "office.hire")).toBe(false);
    expect(grantAllows(["*"], "settings.set")).toBe(false);
    expect(grantAllows(["*"], "soul.set")).toBe(false);
    expect(grantAllows(["*"], "web.search")).toBe(true);
  });
});

describe("the crew", () => {
  it("a worker answers, and keeps its conversation and notes apart from the assistant's and from other workers", async () => {
    const p = new FakeProvider([
      [call("1", "memory.remember", { text: "Invoices go out on the 5th" }), done],
      [text("Noted: invoices go out on the 5th."), done],
      [text("Ben here. I know nothing of that."), done],
    ]);
    const { crew } = build(p);
    expect(crew.hire({ name: "Ada", role: "bookkeeper" }).ok).toBe(true);
    expect(crew.hire({ name: "Ben", role: "researcher" }).ok).toBe(true);
    const a = await crew.ask("Ada", "Remember when invoices go out");
    expect(a).toEqual({ ok: true, text: "Noted: invoices go out on the 5th." });
    const b = await crew.ask("ben", "What do you know about invoices?");
    expect(b).toMatchObject({ ok: true, text: "Ben here. I know nothing of that." });
    // the assistant's own conversation and notes hold nothing of it
    expect(db.prepare("select count(*) c from messages").get()).toEqual({ c: 0 });
    expect(new Memory(db).list()).toEqual([]);
    // each worker has its own
    const ada = await crew.history("Ada");
    expect(ada).toMatchObject({ ok: true });
    expect((ada as { text: string }).text).toContain("Remember when invoices go out");
    expect((ada as { text: string }).text).not.toContain("invoices go out on the 5th.\nAsked: What do you know");
    const ben = (await crew.history("Ben")) as { text: string };
    expect(ben.text).toContain("What do you know about invoices?");
    expect(ben.text).not.toContain("Remember when invoices go out");
    // Ada's notes are a wiki in Ada's own folder; Ben has none and the assistant's wiki is not even started
    expect(new MemoryTree(join(dir, "crew", "ada", "memory")).search("invoices")).toHaveLength(1);
    expect(new MemoryTree(join(dir, "crew", "ben", "memory")).search("invoices")).toEqual([]);
    expect(existsSync(join(dir, "memory"))).toBe(false);
  });

  it("a worker is offered only the tools it was given, and a call outside them is refused", async () => {
    const p = new FakeProvider([[call("1", "task.list", {}), done], [text("could not"), done]]);
    const { crew } = build(p);
    crew.hire({ name: "Ada", role: "researcher", tools: ["web.*"] });
    await crew.ask("Ada", "list the to-dos");
    const offered = names(p);
    expect(offered).toContain("memory.remember");
    expect(offered).not.toContain("task.list");
    expect(offered).not.toContain("shell.run");
    expect(offered.some((n) => n.startsWith("crew.") || n.startsWith("office.") || n.startsWith("soul."))).toBe(false);
    expect(JSON.stringify(p.calls[1]!.messages.at(-1))).toMatch(/not one of your tools/);
  });

  it("equip changes what it may use at once", async () => {
    const p = new FakeProvider([[text("one"), done], [text("two"), done]]);
    const { crew } = build(p);
    crew.hire({ name: "Ada", role: "r", tools: [] });
    await crew.ask("Ada", "x");
    expect(names(p, 0)).not.toContain("weather.get");
    expect(crew.equip("Ada", ["weather.get"])).toEqual({ ok: true });
    await crew.ask("Ada", "y");
    expect(names(p, 1)).toContain("weather.get");
  });

  it("its prompt names the worker and its role, not the assistant", async () => {
    const p = new FakeProvider([[text("ok"), done]]);
    const { crew } = build(p);
    crew.hire({ name: "Ada", role: "bookkeeper", brief: "Keep the books tidy." });
    await crew.ask("Ada", "hi");
    const sys = JSON.stringify(p.calls[0]);
    expect(sys).toContain("Ada");
    expect(sys).toContain("bookkeeper");
    expect(sys).toContain("Keep the books tidy.");
  });

  it("fire deletes the worker with its notes, or keeps them to hire it back", async () => {
    const p = new FakeProvider([[call("1", "memory.remember", { text: "A fact" }), done], [text("ok"), done], [text("ok again"), done]]);
    const { crew } = build(p);
    crew.hire({ name: "Ada", role: "r" });
    await crew.ask("Ada", "remember");
    expect(crew.fire("Ada", true)).toEqual({ ok: true });
    expect(crew.list()).toEqual([]);
    expect(crew.hire({ name: "Ada", role: "r" }).ok).toBe(true);
    expect(new MemoryTree(join(dir, "crew", "ada", "memory")).search("fact")).toHaveLength(1);
    crew.fire("Ada");
    crew.hire({ name: "Ada", role: "r" });
    expect(new MemoryTree(join(dir, "crew", "ada", "memory")).search("fact")).toEqual([]);
  });

  it("a worker cannot ask the crew, hire, or run the house", async () => {
    const p = new FakeProvider([[call("1", "crew.hire", { name: "Eve", role: "x" }), done], [text("no"), done]]);
    const { crew } = build(p);
    crew.hire({ name: "Ada", role: "r", tools: ["*"] });
    await crew.ask("Ada", "hire someone");
    expect(crew.list().map((w) => w.name)).toEqual(["Ada"]);
  });

  it("refuses a name that is taken and a worker that does not exist", async () => {
    const { crew } = build(new FakeProvider([]));
    crew.hire({ name: "Ada", role: "r" });
    expect(crew.hire({ name: "ada", role: "r" })).toMatchObject({ ok: false });
    expect(await crew.ask("Zed", "hi")).toMatchObject({ ok: false });
  });
});

describe("the assistant's crew tools", () => {
  it("hire needs no card, ask returns the worker's answer, and the worker's talk stays out of the assistant's conversation", async () => {
    const p = new FakeProvider([
      [call("1", "crew.hire", { name: "Ada", role: "researcher", tools: ["web.*"] }), done],
      [call("2", "crew.ask", { worker: "Ada", text: "find the capital of France", wait: true }), done],
      [text("Paris."), done], // the worker
      [text("Ada says Paris."), done], // the assistant
    ]);
    const { agent, crew } = build(p);
    await agent.runTurn("hire Ada to research and ask her", owner());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false); // the crew is the assistant's alone: the owner is never asked
    expect(crew.find("Ada")?.tools).toEqual(["web.*"]);
    const last = JSON.stringify(p.calls[3]!.messages);
    expect(last).toContain("Ada answers");
    expect(last).toContain("Paris.");
    const stored = (db.prepare("select content_json from messages").all() as { content_json: string }[]).map((r) => r.content_json).join("\n");
    expect(stored).not.toContain("find the capital of France\"}]}"); // the task was a tool argument, not a message of the assistant's own talk
    const adaDb = openDb(join(dir, "crew", "ada"));
    const theirs = (adaDb.prepare("select content_json from messages").all() as { content_json: string }[]).map((r) => r.content_json).join("\n");
    expect(theirs).toContain("find the capital of France");
  });
});

describe("working without the owner and without blocking the assistant", () => {
  it("a worker uses what it was given without asking the owner", async () => {
    const p = new FakeProvider([[call("1", "fs.write", { path: "C:\somewhere\a.txt", content: "x" }), done], [text("written"), done]]);
    const { crew, deps } = build(p);
    crew.hire({ name: "Ada", role: "writer", tools: ["fs.write"] });
    const r = await crew.ask("Ada", "write a file", { emit: (m) => emitted.push(m) });
    expect(r).toMatchObject({ ok: true });
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(deps.devices.exec).toHaveBeenCalled();
  });

  it("a task started without waiting leaves the assistant free and reports when it is done", async () => {
    const p = new FakeProvider([[text("Paris."), done]]);
    const told: { w: string; r: { ok: boolean; text: string } }[] = [];
    const { crew } = build(p, (w, r) => told.push({ w, r }));
    crew.hire({ name: "Ada", role: "r" });
    const s = crew.start("Ada", "capital of France?");
    expect(s).toEqual({ ok: true, name: "Ada" });
    expect(told).toEqual([]); // not waited for
    await vi.waitFor(() => expect(told).toHaveLength(1));
    expect(told[0]).toEqual({ w: "Ada", r: { ok: true, text: "Paris." } });
  });

  it("what the owner says while the assistant is busy waits for her and is answered, never dropped", async () => {
    const p = new FakeProvider([[text("first"), done], [text("second"), done]]);
    const { agent } = build(p);
    const chat = { trust: "owner" as const, emit: (m: ServerMsg) => emitted.push(m), ip, source: "chat" };
    const a = agent.runTurn("one", chat);
    void agent.runTurn("two", chat); // arrives while she is on the first
    await a;
    await vi.waitFor(() => expect(p.calls).toHaveLength(2));
    expect(JSON.stringify(p.calls[1]!.messages)).toContain("two");
  });
});
