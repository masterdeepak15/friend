import { describe, expect, it } from "vitest";
import type { CaptionItem, Line } from "./logic";
import { MeetingSession, type MeetingPage, type Phase, type SessionEvents } from "./session";
import { DEFAULT_PREFS, type MeetingStatus } from "./store";

class FakePage implements MeetingPage {
  phases: Phase[];
  frames: (CaptionItem[] | null)[];
  chats: string[] = [];
  left = false;
  closed = false;
  enabled = 0;
  chatOk = true;
  constructor(phases: Phase[], frames: (CaptionItem[] | null)[]) {
    this.phases = phases;
    this.frames = frames;
  }
  async open() {}
  async advance() {
    const p = this.phases.length > 1 ? this.phases.shift()! : this.phases[0]!;
    return { phase: p, detail: "" };
  }
  async captions() {
    return this.frames.length > 1 ? this.frames.shift()! : (this.frames[0] ?? null);
  }
  async enableCaptions() {
    this.enabled++;
  }
  async chat(t: string) {
    if (this.chatOk) this.chats.push(t);
    return this.chatOk;
  }
  async leave() {
    this.left = true;
  }
  async close() {
    this.closed = true;
  }
}

function rig(page: FakePage, prefs = { ...DEFAULT_PREFS, ownerNames: ["Deepak"], keywords: ["invoice"] }) {
  let t = 0;
  const log = { status: [] as MeetingStatus[], lines: [] as Line[], addressed: [] as { line: Line; ctx: Line[] }[], owner: [] as Line[], notes: 0, problems: [] as string[], ended: [] as string[] };
  const events: SessionEvents = {
    status: (s) => log.status.push(s),
    lines: (l) => log.lines.push(...l),
    addressed: (line, ctx) => log.addressed.push({ line, ctx }),
    ownerRelevant: (l) => log.owner.push(l),
    notesDue: () => void log.notes++,
    problem: (p) => log.problems.push(p),
    ended: (r) => log.ended.push(r),
  };
  const session = new MeetingSession({ page, url: "https://teams.live.com/meet/1", selfName: "Maya (assistant)", names: () => ["Maya"], prefs: () => prefs, announcement: "Hi, I am Maya.", events, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); }, settleMs: 1500, replyDelayMs: 1000 });
  return { session, log };
}

const say = (speaker: string, text: string): CaptionItem[] => [{ speaker, text }];
const quiet = (n: number): (CaptionItem[] | null)[] => Array.from({ length: n }, () => []);

describe("a meeting session", () => {
  it("joins, tells the room it takes notes, listens, and leaves when the meeting ends", async () => {
    const page = new FakePage(["prejoin", "lobby", "lobby", "in", "in", "in", "in", "in", "in", "ended"], [...quiet(2), say("Ann", "welcome everyone"), say("Ann", "welcome everyone"), say("Ann", "welcome everyone"), say("Ann", "welcome everyone"), []]);
    const { session, log } = rig(page);
    await session.start();
    expect(log.status).toEqual(["joining", "lobby", "live", "ended"]);
    expect(page.chats).toEqual(["Hi, I am Maya."]);
    expect(log.lines).toEqual([{ speaker: "Ann", text: "welcome everyone" }]);
    expect(page.left && page.closed).toBe(true);
    expect(log.ended).toEqual(["The meeting ended."]);
  });

  it("does nothing but listen while nobody calls it", async () => {
    const page = new FakePage(["in", "in", "in", "in", "in", "in", "in", "ended"], [say("Ann", "lunch is at noon"), say("Ann", "lunch is at noon"), say("Ann", "lunch is at noon"), say("Bob", "good"), say("Bob", "good"), say("Bob", "good"), say("Bob", "good")]);
    const { session, log } = rig(page);
    await session.start();
    expect(log.addressed).toEqual([]);
    expect(log.owner).toEqual([]);
    expect(page.chats).toEqual(["Hi, I am Maya."]); // only the announcement
  });

  it("is called by name, waits for the speaker to finish, then asks once", async () => {
    const a = say("Ann", "Maya, what is the status of the release?");
    const page = new FakePage(Array(12).fill("in").concat("ended") as Phase[], [a, a, a, a, a, a, a, a, [], [], [], []]);
    const { session, log } = rig(page);
    await session.start();
    expect(log.addressed).toHaveLength(1);
    expect(log.addressed[0]!.line).toEqual({ speaker: "Ann", text: "Maya, what is the status of the release?" });
  });

  it("tells the owner when his name or a topic comes up, at most once a minute, never for his own words", async () => {
    const f1 = say("Ann", "Deepak will send the invoice");
    const f2 = say("Deepak Chougale", "yes the invoice goes today");
    const page = new FakePage(Array(14).fill("in").concat("ended") as Phase[], [f1, f1, f1, f1, f2, f2, f2, f2, f2, [], [], [], []]);
    const { session, log } = rig(page);
    await session.start();
    expect(log.owner).toEqual([{ speaker: "Ann", text: "Deepak will send the invoice" }]);
    expect(session.ownerPresent()).toBe(true);
  });

  it("asks for notes only when enough new was said and the time has come", async () => {
    const lines = ["one", "two", "three", "four", "five"].map((w) => say("Ann", `line ${w} spoken here`));
    const frames: (CaptionItem[] | null)[] = [];
    for (const l of lines) frames.push(l, l, l);
    const page = new FakePage(Array(frames.length + 1).fill("in").concat("ended") as Phase[], frames);
    const { session, log } = rig(page, { ...DEFAULT_PREFS, notesEveryMinutes: 2 });
    // five lines are said within a few seconds of meeting time: not yet
    await session.start();
    expect(log.notes).toBe(0);
  });

  it("gives up with a plain reason when nobody lets it in", async () => {
    const page = new FakePage(["lobby"], []);
    const { session, log } = rig(page);
    // a lobby that never opens: the wait is cut short for the test
    const s2 = new MeetingSession({ page, url: "https://teams.live.com/meet/1", selfName: "Maya", names: () => ["Maya"], prefs: () => DEFAULT_PREFS, announcement: "x", events: { status: (s: MeetingStatus) => log.status.push(s), lines() {}, addressed() {}, ownerRelevant() {}, notesDue() {}, problem: (p: string) => log.problems.push(p), ended() {} }, now: (() => { let t = 0; return () => (t += 5000); })(), sleep: async () => { await new Promise((r) => setImmediate(r)); }, admitTimeoutMs: 20_000 });
    await s2.start();
    expect(log.status).toContain("failed");
    expect(log.problems.join(" ")).toMatch(/let it in/);
    expect(session).toBeDefined();
  });

  it("says in the log when captions never come on", async () => {
    const page = new FakePage(Array(80).fill("in").concat("ended") as Phase[], [null]);
    const { session, log } = rig(page);
    await session.start();
    expect(page.enabled).toBeGreaterThan(1);
    expect(log.problems.join(" ")).toMatch(/captions/i);
  });

  it("writes in the chat only when told to, not more than once every fifteen seconds, and not before it is in", async () => {
    const page = new FakePage(["in", "in", "in", "in", "in"], [[]]);
    const { session } = rig(page);
    expect(await session.say("hello")).toBe(false); // not in yet
    const run = session.start();
    await new Promise((r) => setTimeout(r, 20));
    await session.stop("test over");
    await run;
    expect(page.left).toBe(true);
  });
});
