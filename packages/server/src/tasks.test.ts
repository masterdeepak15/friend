import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { MAX_OPEN_TASKS, MAX_TITLE_CHARS, Tasks } from "./tasks";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
let now: number;
let tasks: Tasks;
beforeEach(() => {
  now = Date.UTC(2026, 9, 8, 12, 0, 0);
  tasks = new Tasks(openDb(mkdtempSync(join(tmpdir(), "friend-tasks-"))), () => now);
});
const idOf = (r: ReturnType<Tasks["add"]>) => (r.ok ? r.id : -1);

describe("Tasks.add", () => {
  it("keeps a plain to-do and a timed reminder", () => {
    expect(tasks.add({ title: "Buy milk" }).ok).toBe(true);
    expect(tasks.add({ title: "Call the bank", dueAt: now + 30 * MIN }).ok).toBe(true);
    expect(tasks.list().map((t) => t.title)).toEqual(["Call the bank", "Buy milk"]); // timed first, to-dos last
  });

  it("tidies the title and refuses empty or over-long ones", () => {
    tasks.add({ title: "  water   the\nplants " });
    expect(tasks.list()[0]!.title).toBe("water the plants");
    expect(tasks.add({ title: "  " })).toEqual({ ok: false, error: "A task needs a title." });
    expect(tasks.add({ title: "x".repeat(MAX_TITLE_CHARS + 1) })).toEqual({
      ok: false,
      error: `That title is too long (the limit is ${MAX_TITLE_CHARS} characters).`,
    });
  });

  it("refuses a time in the past or exactly now", () => {
    expect(tasks.add({ title: "late", dueAt: now - 1 })).toEqual({ ok: false, error: "That time has already passed." });
    expect(tasks.add({ title: "now", dueAt: now })).toEqual({ ok: false, error: "That time has already passed." });
  });

  it("refuses a repeat without a time, and a non-finite time", () => {
    expect(tasks.add({ title: "gym", repeat: "daily" })).toEqual({ ok: false, error: "A repeating task needs a time." });
    expect(tasks.add({ title: "x", dueAt: Number.NaN }).ok).toBe(false);
  });

  it("stops at the open-task limit but counts only open ones", () => {
    for (let i = 0; i < MAX_OPEN_TASKS; i++) tasks.add({ title: `t${i}` });
    expect(tasks.add({ title: "one more" })).toEqual({ ok: false, error: "The task list is full. Finish or remove something first." });
    const first = tasks.list()[0]!;
    tasks.done(first.id);
    expect(tasks.add({ title: "one more" }).ok).toBe(true);
  });
});

describe("Tasks.done / remove", () => {
  it("closes a one-off task, which then leaves the list", () => {
    const id = idOf(tasks.add({ title: "a" }));
    expect(tasks.done(id)).toEqual({ ok: true, rescheduled: false });
    expect(tasks.list()).toEqual([]);
    expect(tasks.done(id)).toEqual({ ok: false, error: "No open task with that number." });
  });

  it("reschedules a repeating task instead of closing it", () => {
    const id = idOf(tasks.add({ title: "stretch", dueAt: now + HOUR, repeat: "daily" }));
    expect(tasks.done(id)).toEqual({ ok: true, rescheduled: true });
    expect(tasks.list()[0]).toMatchObject({ id, dueAt: now + HOUR + DAY, repeat: "daily" });
  });

  it("removes a task and reports unknown numbers", () => {
    const id = idOf(tasks.add({ title: "a" }));
    expect(tasks.remove(id)).toBe(true);
    expect(tasks.remove(id)).toBe(false);
  });
});

describe("Tasks due and markFired", () => {
  it("reports a task once it is due, and only until it has fired", () => {
    const id = idOf(tasks.add({ title: "call", dueAt: now + 10 * MIN }));
    expect(tasks.due()).toEqual([]);
    now += 10 * MIN;
    expect(tasks.due().map((t) => t.id)).toEqual([id]);
    tasks.markFired(id);
    expect(tasks.due()).toEqual([]);
    expect(tasks.list().map((t) => t.id)).toEqual([id]); // still open until the owner marks it done
  });

  it("moves a repeating task to the next slot after now, skipping any missed ones", () => {
    const id = idOf(tasks.add({ title: "backup", dueAt: now + HOUR, repeat: "hourly" }));
    now += 5 * HOUR + 10 * MIN; // five slots were missed
    expect(tasks.due().map((t) => t.id)).toEqual([id]);
    tasks.markFired(id);
    expect(tasks.list()[0]!.dueAt).toBe(now - 10 * MIN + HOUR);
    expect(tasks.due()).toEqual([]);
  });

  it("does not report done tasks or plain to-dos as due", () => {
    const id = idOf(tasks.add({ title: "x", dueAt: now + MIN }));
    tasks.add({ title: "todo" });
    tasks.done(id);
    now += DAY;
    expect(tasks.due()).toEqual([]);
  });
});
