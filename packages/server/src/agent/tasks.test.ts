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
import { Tasks, localIso } from "../tasks";
import { Agent } from "./loop";
import { buildSystemPrompt } from "./prompt";

const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

let emitted: ServerMsg[];
let tasks: Tasks;
let build: (provider: FakeProvider, withTasks?: boolean) => Agent;
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit: (m: ServerMsg) => emitted.push(m), ip: "9.9.9.9" });
const result = (p: FakeProvider, n = 1) => JSON.stringify(p.calls[n]!.messages.at(-1));

beforeEach(async () => {
  emitted = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-taskagent-"));
  const db = openDb(dir);
  tasks = new Tasks(db, () => NOW);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 200);
  build = (provider, withTasks = true) =>
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
      ...(withTasks ? { tasks } : {}),
    });
});

describe("task tools", () => {
  it("adds a reminder in N minutes without asking for approval", async () => {
    const p = new FakeProvider([[call("1", "task.add", { title: "Call the bank", inMinutes: 30 }), done], [text("ok"), done]]);
    await build(p).runTurn("remind me in half an hour to call the bank", ctx());
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(tasks.list()).toMatchObject([{ title: "Call the bank", dueAt: NOW + 30 * 60_000, repeat: null }]);
    expect(result(p)).toMatch(/Added task #\d+/);
  });

  it("adds a reminder at an exact time with an offset, and a repeat", async () => {
    const p = new FakeProvider([
      [call("1", "task.add", { title: "Back up", dueAt: "2026-10-09T17:00:00+05:30", repeat: "weekly" }), done],
      [text("ok"), done],
    ]);
    await build(p).runTurn("every week", ctx());
    expect(tasks.list()[0]).toMatchObject({ dueAt: Date.UTC(2026, 9, 9, 11, 30, 0), repeat: "weekly" });
  });

  it("adds a plain to-do", async () => {
    const p = new FakeProvider([[call("1", "task.add", { title: "Buy milk" }), done], [text("ok"), done]]);
    await build(p).runTurn("add milk", ctx());
    expect(tasks.list()[0]).toMatchObject({ title: "Buy milk", dueAt: null });
  });

  it.each([
    [{ title: "x", dueAt: "tomorrow at five" }, /ISO 8601 with an offset/],
    [{ title: "x", dueAt: "2026-10-09T17:00:00" }, /ISO 8601 with an offset/],
    [{ title: "x", inMinutes: 5, dueAt: "2026-10-09T17:00:00Z" }, /either inMinutes or dueAt/],
    [{ title: "x", dueAt: "2020-01-01T00:00:00Z" }, /already passed/],
    [{ title: "x", repeat: "daily" }, /needs a time/],
    [{ title: "x", inMinutes: 0 }, /Invalid arguments/],
  ])("refuses a bad time or repeat in plain words: %j", async (args, message) => {
    const p = new FakeProvider([[call("1", "task.add", args), done], [text("ok"), done]]);
    await build(p).runTurn("remind me", ctx());
    expect(result(p)).toMatch(message);
    expect(tasks.list()).toEqual([]);
  });

  it("lists open tasks soonest first with local times and repeats", async () => {
    tasks.add({ title: "later", dueAt: NOW + 2 * 3_600_000 });
    tasks.add({ title: "soon", dueAt: NOW + 3_600_000, repeat: "daily" });
    tasks.add({ title: "someday" });
    const p = new FakeProvider([[call("1", "task.list", {}), done], [text("ok"), done]]);
    await build(p).runTurn("what is on my list?", ctx());
    const out = JSON.parse(result(p)).content[0].content as string;
    const lines = out.split("\n");
    expect(lines[0]).toContain("soon");
    expect(lines[0]).toContain(`due ${localIso(new Date(NOW + 3_600_000))}`);
    expect(lines[0]).toContain("repeats daily");
    expect(lines[1]).toContain("later");
    expect(lines[2]).toMatch(/#\d+ someday$/);
  });

  it("says the list is empty", async () => {
    const p = new FakeProvider([[call("1", "task.list", {}), done], [text("ok"), done]]);
    await build(p).runTurn("list", ctx());
    expect(result(p)).toContain("No open tasks.");
  });

  it("marks done, reschedules a repeating task, removes, and reports unknown numbers", async () => {
    const oneOff = tasks.add({ title: "a" });
    const repeating = tasks.add({ title: "b", dueAt: NOW + 3_600_000, repeat: "daily" });
    const gone = tasks.add({ title: "c" });
    const ids = [oneOff, repeating, gone].map((r) => (r.ok ? r.id : -1));
    const p = new FakeProvider([
      [call("1", "task.done", { id: ids[0] }), call("2", "task.done", { id: ids[1] }), call("3", "task.remove", { id: ids[2] }), call("4", "task.done", { id: 999 }), done],
      [text("ok"), done],
    ]);
    await build(p).runTurn("tidy up", ctx());
    const out = JSON.parse(result(p)).content as { content: string; isError: boolean }[];
    expect(out[0]!.content).toMatch(/done/i);
    expect(out[1]!.content).toMatch(/next/i);
    expect(out[2]!.content).toMatch(/removed/i);
    expect(out[3]).toMatchObject({ isError: true, content: expect.stringContaining("No open task with that number.") });
    expect(tasks.list().map((t) => t.title)).toEqual(["b"]);
  });

  it("reports that tasks are unavailable without a task store", async () => {
    const p = new FakeProvider([[call("1", "task.list", {}), done], [text("ok"), done]]);
    await build(p, false).runTurn("list", ctx());
    expect(result(p)).toContain("Tasks are not available.");
  });
});

describe("the clock in the prompt", () => {
  it("tells the owner's turns what time it is, with an offset, so 'at 5pm' can be turned into a time", async () => {
    const p = new FakeProvider([[text("ok"), done]]);
    await build(p).runTurn("hi", ctx());
    expect(p.calls[0]!.system).toMatch(/Current time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/);
  });
  it("is left out of the guest prompt", () => {
    expect(buildSystemPrompt("Jarvis", "empty", "guest")).not.toContain("Current time");
  });
  it("localIso keeps the instant and prints the machine's offset", () => {
    const d = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
    const s = localIso(d);
    expect(s).toMatch(/^2026-10-0[89]T\d\d:\d\d:00[+-]\d\d:\d\d$/);
    expect(Date.parse(s)).toBe(d.getTime());
  });
});
