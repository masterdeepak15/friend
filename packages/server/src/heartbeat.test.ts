import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "./db";
import { Heartbeat } from "./heartbeat";
import { Tasks, type TaskRow } from "./tasks";

const MIN = 60_000;
let now: number;
let tasks: Tasks;
let clients: number;
let busy: boolean;
let notified: TaskRow[];
let beat: Heartbeat;

beforeEach(() => {
  now = Date.UTC(2026, 9, 8, 12, 0, 0);
  tasks = new Tasks(openDb(mkdtempSync(join(tmpdir(), "friend-beat-"))), () => now);
  clients = 1;
  busy = false;
  notified = [];
  beat = new Heartbeat({ tasks, clients: () => clients, busy: () => busy, notify: (t) => void notified.push(t), intervalMs: 15_000 });
});
afterEach(() => beat.stop());

describe("Heartbeat.tick", () => {
  it("tells the owner once when a task falls due", () => {
    tasks.add({ title: "call the bank", dueAt: now + 5 * MIN });
    beat.tick();
    expect(notified).toEqual([]);
    now += 5 * MIN;
    beat.tick();
    beat.tick();
    expect(notified.map((t) => t.title)).toEqual(["call the bank"]);
  });

  it("waits for the owner to be there, then tells them", () => {
    tasks.add({ title: "stand up", dueAt: now + MIN });
    now += MIN;
    clients = 0;
    beat.tick();
    expect(notified).toEqual([]);
    clients = 1;
    beat.tick();
    expect(notified).toHaveLength(1);
  });

  it("does not interrupt a running conversation, and tells them afterwards", () => {
    tasks.add({ title: "tea", dueAt: now + MIN });
    now += MIN;
    busy = true;
    beat.tick();
    expect(notified).toEqual([]);
    busy = false;
    beat.tick();
    expect(notified).toHaveLength(1);
  });

  it("reminds on a repeating task each slot without replaying missed ones", () => {
    tasks.add({ title: "backup", dueAt: now + 60 * MIN, repeat: "hourly" });
    now += 60 * MIN;
    beat.tick();
    expect(notified).toHaveLength(1);
    now += 3 * 60 * MIN + 5 * MIN; // three slots go by while the owner is away
    beat.tick();
    beat.tick();
    expect(notified).toHaveLength(2);
    expect(tasks.list()[0]!.dueAt).toBeGreaterThan(now);
  });

  it("keeps going when one notification fails, and retries that one on the next beat", () => {
    tasks.add({ title: "a", dueAt: now + MIN });
    tasks.add({ title: "b", dueAt: now + MIN });
    now += MIN;
    let first = true;
    beat = new Heartbeat({
      tasks,
      clients: () => 1,
      busy: () => false,
      intervalMs: 15_000,
      notify: (t) => {
        if (t.title === "a" && first) {
          first = false;
          throw new Error("screen exploded");
        }
        notified.push(t);
      },
    });
    beat.tick();
    expect(notified.map((t) => t.title)).toEqual(["b"]);
    beat.tick();
    expect(notified.map((t) => t.title)).toEqual(["b", "a"]);
  });
});

describe("Heartbeat timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("beats on its interval until stopped, and starting twice does not double the beat", () => {
    const tick = vi.spyOn(beat, "tick");
    beat.start();
    beat.start();
    vi.advanceTimersByTime(45_000);
    expect(tick).toHaveBeenCalledTimes(3);
    beat.stop();
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
