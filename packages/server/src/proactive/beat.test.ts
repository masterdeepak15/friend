import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveMessage } from "../agent/history";
import { sanitizeProactive, type ProactiveConfig } from "../config";
import { openDb } from "../db";
import { MemoryTree } from "../memory/tree";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { Tasks } from "../tasks";
import { ProactiveBeat, within, type BeatDeps } from "./beat";

const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const says = (words: string | null) => [text(JSON.stringify({ say: words })), done];

/** A local time on 2026-10-26 (a Monday). */
const at = (h: number, m = 0) => new Date(2026, 9, 26, h, m).getTime();

let db: ReturnType<typeof openDb>;
let dir: string;
let tasks: Tasks;
let tree: MemoryTree;
let cfg: ProactiveConfig;
let now: number;
let screens: number;
let busy: boolean;
let phone: boolean;
let delivered: { text: string; speak: boolean; screens: number; phone: boolean }[];
let audit: { log: ReturnType<typeof vi.fn> };

/** A task that was due earlier today (tasks cannot be added in the past, so the clock is set back to add it). */
const addPast = (title: string, dueAt: number) => {
  const keep = now;
  now = dueAt - 3_600_000;
  tasks.add({ title, dueAt });
  now = keep;
};

const beat = (p: FakeProvider, over: Partial<BeatDeps> = {}) =>
  new ProactiveBeat({
    config: () => cfg,
    provider: p,
    db,
    tree,
    tasks,
    screens: () => screens,
    busy: () => busy,
    assistantName: () => "Maya",
    phoneReady: () => phone,
    deliver: (t, how) => void delivered.push({ text: t, ...how }),
    audit: audit as unknown as BeatDeps["audit"],
    now: () => now,
    statePath: join(dir, "proactive.json"),
    ...over,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "friend-beat-"));
  db = openDb(dir);
  tasks = new Tasks(db, () => now);
  tree = new MemoryTree(join(dir, "memory"), () => now);
  tree.ensure();
  cfg = sanitizeProactive({ level: "medium" });
  now = at(8, 30);
  screens = 1;
  busy = false;
  phone = false;
  delivered = [];
  audit = { log: vi.fn() };
});

describe("clock times", () => {
  it("quiet hours may wrap past midnight", () => {
    expect(within(23 * 60, "22:00", "07:00")).toBe(true);
    expect(within(3 * 60, "22:00", "07:00")).toBe(true);
    expect(within(12 * 60, "22:00", "07:00")).toBe(false);
    expect(within(7 * 60, "22:00", "07:00")).toBe(false);
    expect(within(9 * 60, "08:00", "12:00")).toBe(true);
    expect(within(9 * 60, "09:00", "09:00")).toBe(false);
  });
});

describe("when it does not even look", () => {
  it("is off by default, and a bad level in the saved file is off", async () => {
    expect(sanitizeProactive(undefined).level).toBe("off");
    expect(sanitizeProactive({ level: "loud" as never }).level).toBe("off");
    cfg.level = "off";
    const p = new FakeProvider([says("hi")]);
    expect(await beat(p).tick()).toBeNull();
    expect(p.calls).toHaveLength(0);
  });

  it("stays quiet in quiet hours, while the assistant is busy, and while the owner is talking", async () => {
    const p = new FakeProvider([says("Good morning")]);
    now = at(23, 0);
    expect(await beat(p).tick()).toBeNull();
    now = at(8, 30);
    busy = true;
    expect(await beat(p).tick()).toBeNull();
    busy = false;
    saveMessage(db, { role: "user", content: [{ type: "text", text: "hello" }] });
    now = Date.now() + 1000; // the owner spoke a moment ago (the time stamps are real time)
    const real = beat(new FakeProvider([says("x")]), { now: () => Date.now() });
    expect(await real.tick()).toBeNull();
    expect(p.calls).toHaveLength(0);
  });

  it("stops at the daily cap, and keeps a gap between two contacts", async () => {
    cfg.dailyCap = 1;
    const p = new FakeProvider([says("Good morning, Deepak"), says("Anything else?")]);
    const b = beat(p);
    expect((await b.tick())?.spoke).toBe(true);
    now = at(20, 31);
    expect(await b.tick()).toBeNull(); // the cap of one is used
    cfg.dailyCap = 6;
    cfg.minGapMin = 30;
    now = at(8, 45); // 15 minutes after the first
    expect(await b.tick()).toBeNull();
  });
});

describe("what it speaks about", () => {
  it("low: only a task that is long overdue, and only once", async () => {
    cfg.level = "low";
    addPast("Send the invoice", at(5, 0));
    const p = new FakeProvider([says("The invoice was due this morning; shall I help?"), says("again")]);
    const b = beat(p);
    const r = await b.tick();
    expect(r).toMatchObject({ spoke: true, kind: "overdue", text: "The invoice was due this morning; shall I help?" });
    now = at(10, 0);
    expect(await b.tick()).toBeNull(); // dealt with: not asked again
    expect(p.calls).toHaveLength(1);
    expect(JSON.stringify(p.calls[0]!.messages[0])).toMatch(/Send the invoice/);
  });

  it("low does not do the morning, the evening, a dated note or the silence", async () => {
    cfg.level = "low";
    const p = new FakeProvider([says("Good morning")]);
    expect(await beat(p).tick()).toBeNull();
    now = at(21, 0);
    expect(await beat(p).tick()).toBeNull();
  });

  it("medium: a morning check-in with what is due today, once a day", async () => {
    tasks.add({ title: "Dentist at 5", dueAt: at(17, 0) });
    const p = new FakeProvider([says("Good morning! The dentist is at 5 today."), says("again")]);
    const b = beat(p, { officeLine: () => "2 workers, 1 working, 0 waiting for the owner, 1 tickets to review" });
    const r = await b.tick();
    expect(r).toMatchObject({ spoke: true, kind: "morning" });
    const ask = JSON.stringify(p.calls[0]!.messages[0]);
    expect(ask).toMatch(/Due today: Dentist at 5/);
    expect(ask).toMatch(/Office: 2 workers/);
    expect(p.calls[0]!.tools).toEqual([]);
    expect(p.calls[0]!.session).toBe("guest");
    expect(String(p.calls[0]!.system)).toMatch(/You are Maya/);
    now = at(9, 30);
    expect(await b.tick()).toBeNull();
    expect(p.calls).toHaveLength(1);
  });

  it("medium: the evening check-in, but not inside quiet hours", async () => {
    const p = new FakeProvider([says("How did the day go?")]);
    now = at(20, 45);
    expect(await beat(p).tick()).toMatchObject({ spoke: true, kind: "evening" });
    cfg = sanitizeProactive({ level: "medium", quietFrom: "20:00", quietTo: "07:00" });
    delivered = [];
    expect(await beat(new FakeProvider([says("x")])).tick()).toBeNull();
  });

  it("medium: a note in memory dated today or tomorrow is mentioned", async () => {
    now = at(14, 0); // not the morning or the evening
    tree.write("work/interview.md", "Interview with Acme on 2026-10-27 at 11 am. Revise Blazor.", { title: "Acme interview" });
    const p = new FakeProvider([says("Your Acme interview is tomorrow at 11.")]);
    const r = await beat(p).tick();
    expect(r).toMatchObject({ spoke: true, kind: "dated" });
    expect(JSON.stringify(p.calls[0]!.messages[0])).toMatch(/work\/interview\.md.*tomorrow.*Acme interview/);
    expect(await beat(new FakeProvider([says("again")])).tick()).toBeNull(); // kept across a restart: not said twice
  });

  it("high: a gentle check-in after a long silence, in waking hours only", async () => {
    cfg.level = "high";
    cfg.minGapMin = 5;
    now = at(15, 0);
    saveMessage(db, { role: "user", content: [{ type: "text", text: "earlier" }] });
    db.prepare("update messages set created_at = ?").run(at(5, 0) - 10 * 3_600_000);
    const p = new FakeProvider([says("Hey, quiet day? I am here if you need anything.")]);
    expect(await beat(p).tick()).toMatchObject({ spoke: true, kind: "silence" });
    cfg.level = "medium";
    now = at(15, 30);
    expect(await beat(new FakeProvider([says("x")])).tick()).toBeNull();
  });
});

describe("what the model decides", () => {
  it("can choose to say nothing, and then it is not asked again about the same thing", async () => {
    const p = new FakeProvider([says(null), says("Good morning")]);
    const b = beat(p);
    expect(await b.tick()).toMatchObject({ spoke: false, kind: "morning" });
    expect(delivered).toEqual([]);
    expect(audit.log).toHaveBeenCalledWith("agent", "proactive.quiet", { kind: "morning" });
    expect(await b.tick()).toBeNull();
    expect(p.calls).toHaveLength(1);
  });

  it("an answer that is not JSON, or a model that fails, says nothing and does not crash", async () => {
    expect(await beat(new FakeProvider([[text("Sure! Good morning."), done]])).tick()).toMatchObject({ spoke: false });
    now = at(8, 31);
    fs_reset();
    expect(await beat(new FakeProvider([[{ type: "error", message: "limit" }]])).tick()).toMatchObject({ spoke: false });
    expect(delivered).toEqual([]);
  });

  it("cuts a long message and tells the model what was already said today", async () => {
    cfg.minGapMin = 5;
    addPast("Water the plants", at(3, 0));
    const long = "word ".repeat(200);
    const p = new FakeProvider([says(long), says("Good morning!")]);
    const b = beat(p);
    const r = await b.tick();
    expect(r && r.spoke && r.text.length).toBeLessThanOrEqual(400);
    now = at(8, 40);
    await b.tick();
    expect(JSON.stringify(p.calls[1]!.messages[0])).toMatch(/Already said today/);
  });
});

describe("who hears it", () => {
  it("on the screen, aloud only when the owner asked for that", async () => {
    await beat(new FakeProvider([says("Good morning")])).tick();
    expect(delivered).toEqual([{ text: "Good morning", speak: false, screens: 1, phone: false }]);
    delivered = [];
    cfg.speak = true;
    now = at(21, 0);
    await beat(new FakeProvider([says("Evening!")])).tick();
    expect(delivered[0]).toMatchObject({ speak: true });
  });

  it("with no screen open, to the phone when it is linked; with neither, it waits for someone to be there", async () => {
    screens = 0;
    phone = true;
    await beat(new FakeProvider([says("Good morning")])).tick();
    expect(delivered).toEqual([{ text: "Good morning", speak: false, screens: 0, phone: true }]);
    delivered = [];
    cfg.phone = false;
    now = at(21, 0);
    const p = new FakeProvider([says("Evening")]);
    expect(await beat(p).tick()).toBeNull(); // no screen and no phone: nothing to look for
    screens = 0;
    phone = false;
    cfg.phone = true;
    const q = new FakeProvider([says("Evening")]);
    expect(await beat(q).tick()).toBeNull();
    expect(delivered).toEqual([]);
  });

  it("a signal that found nobody to tell is kept for when a screen opens", async () => {
    cfg.phone = true;
    screens = 1;
    const p = new FakeProvider([says("Good morning")]);
    const b = beat(p, { deliver: () => void delivered.push({ text: "x", speak: false, screens: 0, phone: false }) });
    expect((await b.tick())?.spoke).toBe(true);
  });
});

// a new instance reads the day's state from disk: reset it between two ticks of different instances in one test
function fs_reset(): void {
  try {
    rmSync(join(dir, "proactive.json"), { force: true });
  } catch {
    /* nothing to reset */
  }
}
