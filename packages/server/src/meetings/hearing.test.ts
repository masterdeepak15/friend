import { describe, expect, it } from "vitest";
import { AudioHearing, cleanTranscript } from "./hearing";
import { pcmToWav, systemSpeech } from "./speech";
import { MeetingSession, type MeetingPage, type Phase } from "./session";
import { DEFAULT_PREFS } from "./store";
import type { CaptionItem, Line } from "./logic";

const RATE = 16000;
const speech = (seconds: number): Buffer => {
  const b = Buffer.alloc(Math.floor(seconds * RATE) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * 9000 * (0.6 + 0.4 * Math.sin(i / 3000))), i * 2);
  return b;
};
const quiet = (seconds: number) => Buffer.alloc(Math.floor(seconds * RATE) * 2);
const until = async (cond: () => boolean, ms = 8000) => {
  for (let t = 0; t < ms && !cond(); t += 10) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("timed out waiting");
};

describe("what a speech model writes for sound that is not speech", () => {
  it("drops notes, sounds in brackets and the phrases a model makes up for silence", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("(music) ♪♪")).toBe("");
    expect(cleanTranscript("Thanks for watching!")).toBe("");
    expect(cleanTranscript("you")).toBe("");
    expect(cleanTranscript("  Maya, [cough] what is the plan? ")).toBe("Maya, what is the plan?");
  });
});

describe("hearing a meeting that has no captions", () => {
  it("turns a stretch with speech in it into a line from Someone, cut at the pause, and sends nothing for silence", async () => {
    const heard: number[] = [];
    const h = new AudioHearing({ transcribe: async (pcm) => (heard.push(pcm.length), "Maya, are you there?") });
    h.push(quiet(6)); // a long silence: not sent
    h.push(speech(5));
    h.push(quiet(0.8)); // the pause
    await h.finish();
    expect(h.take()).toEqual([{ speaker: "Someone", text: "Maya, are you there?" }]);
    expect(heard).toHaveLength(1); // the silence did not go to the model
    expect(heard[0]! / 2 / RATE).toBeGreaterThan(4);
  });

  it("gives the line its speaker name and keeps going when the model fails once", async () => {
    let n = 0;
    const h = new AudioHearing({
      speaker: "Someone",
      transcribe: async () => {
        if (n++ === 0) throw new Error("the program crashed");
        return "The budget is approved.";
      },
    });
    for (let i = 0; i < 2; i++) {
      h.push(speech(5));
      h.push(quiet(0.8));
    }
    await h.finish();
    expect(h.take()).toEqual([{ speaker: "Someone", text: "The budget is approved." }]);
  });

  it("cuts a long stretch of talking without a pause, so the answer is never far behind", async () => {
    const sizes: number[] = [];
    const h = new AudioHearing({ transcribe: async (p) => (sizes.push(p.length / 2 / RATE), "words") });
    h.push(speech(15));
    await h.finish();
    expect(sizes).toEqual([15]);
  });

  it("drops the oldest sound when the model is far behind", async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = new AudioHearing({ transcribe: async (p) => (await gate, seen.push(p.length), "x y") });
    for (let i = 0; i < 6; i++) {
      h.push(speech(15));
    }
    release();
    await h.finish();
    expect(seen.length).toBeLessThanOrEqual(4); // one running + three waiting at most
  });
});

describe("the sound files", () => {
  it("makes a WAV header Chrome can read", () => {
    const w = pcmToWav(Buffer.alloc(32000), 16000);
    expect(w.subarray(0, 4).toString()).toBe("RIFF");
    expect(w.subarray(8, 12).toString()).toBe("WAVE");
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt32LE(40)).toBe(32000);
    expect(w.length).toBe(44 + 32000);
  });

  it.skipIf(process.platform !== "win32")("speaks with the voice of this PC and gives back a WAV, with the text taken as text and not as a command", async () => {
    const wav = await systemSpeech()('Hello "there"; $(echo pwned) `ls` & more.');
    expect(wav).not.toBeNull();
    expect(wav!.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav!.length).toBeGreaterThan(5000);
  }, 60_000);
});

/** A page with no captions and a call whose sound arrives a little at a time. */
class QuietPage implements MeetingPage {
  micCalls: boolean[] = [];
  played: Buffer[] = [];
  sound: Buffer[] = [];
  chats: string[] = [];
  async open() {}
  async advance() {
    return { phase: "in" as Phase, detail: "" };
  }
  async captions(): Promise<CaptionItem[] | null> {
    return null;
  }
  async enableCaptions() {}
  async chat(t: string) {
    this.chats.push(t);
    return true;
  }
  async leave() {}
  async close() {}
  async mic(on: boolean) {
    this.micCalls.push(on);
    return true;
  }
  async speak(w: Buffer) {
    this.played.push(w);
    return true;
  }
  async audio() {
    return this.sound.shift() ?? Buffer.alloc(0);
  }
}

const events = (log: { lines: Line[]; addressed: Line[]; problems: string[] }) => ({
  status: () => {},
  lines: (l: Line[]) => log.lines.push(...l),
  addressed: (l: Line) => void log.addressed.push(l),
  ownerRelevant: () => {},
  notesDue: () => {},
  problem: (t: string) => void log.problems.push(t),
  ended: () => {},
});

describe("a session that cannot read captions", () => {
  it("listens to the sound instead, answers when called by name, and tells the owner it cannot tell who speaks", async () => {
    const page = new QuietPage();
    page.sound.push(quiet(0.1), Buffer.concat([speech(5), quiet(0.8)])); // what is there on arrival is old and thrown away
    const log = { lines: [] as Line[], addressed: [] as Line[], problems: [] as string[] };
    const s = new MeetingSession({
      page,
      url: "https://teams.live.com/meet/1",
      selfName: "Maya",
      names: () => ["Maya"],
      prefs: () => DEFAULT_PREFS,
      announcement: "hi",
      pollMs: 5,
      replyDelayMs: 20,
      hearing: new AudioHearing({ transcribe: async () => "Maya, what is the status?" }),
      events: events(log),
    });
    const done = s.start();
    await until(() => log.addressed.length === 1);
    expect(log.lines[0]).toEqual({ speaker: "Someone", text: "Maya, what is the status?" });
    expect(log.problems.join(" ")).toMatch(/listening to the sound/);
    await s.stop("test over");
    await done;
  }, 20_000);

  it("without a speech model it says so after a minute of polls and stays quiet", async () => {
    const page = new QuietPage();
    const log = { lines: [] as Line[], addressed: [] as Line[], problems: [] as string[] };
    const s = new MeetingSession({ page, url: "https://teams.live.com/meet/1", selfName: "Maya", names: () => ["Maya"], prefs: () => DEFAULT_PREFS, announcement: "hi", pollMs: 1, events: events(log) });
    const done = s.start();
    await until(() => log.problems.some((p) => /cannot hear anything/.test(p)));
    await s.stop("test over");
    await done;
    expect(log.lines).toEqual([]);
  }, 20_000);
});

describe("speaking aloud", () => {
  const make = (over: Partial<ConstructorParameters<typeof MeetingSession>[0]> = {}, page = new QuietPage()) => {
    const log = { lines: [] as Line[], addressed: [] as Line[], problems: [] as string[] };
    const spoken: string[] = [];
    const s = new MeetingSession({
      page,
      url: "https://teams.live.com/meet/1",
      selfName: "Maya",
      names: () => ["Maya"],
      prefs: () => DEFAULT_PREFS,
      announcement: "hi",
      pollMs: 5,
      speech: async (t) => (spoken.push(t), Buffer.from("RIFFwav")),
      events: events(log),
      ...over,
    });
    return { s, page, spoken, log };
  };

  it("switches the microphone on, plays the voice, and switches it off again; it arrives muted", async () => {
    const { s, page, spoken } = make();
    const done = s.start();
    await until(() => page.micCalls.length === 1); // muted on arrival
    expect(page.micCalls).toEqual([false]);
    await until(() => (s as unknown as { status: string }).status === "live");
    expect(await s.speak("The release is on track.")).toEqual({ ok: true, message: "Said aloud." });
    expect(spoken).toEqual(["The release is on track."]);
    expect(page.played).toHaveLength(1);
    expect(page.micCalls).toEqual([false, true, false]);
    await s.stop("test over");
    await done;
  }, 20_000);

  it("speaks at most once in twenty seconds, and not when it was not switched on", async () => {
    const a = make();
    const done = a.s.start();
    await until(() => (a.s as unknown as { status: string }).status === "live");
    expect((await a.s.speak("one")).ok).toBe(true);
    expect(await a.s.speak("two")).toMatchObject({ ok: false, message: expect.stringMatching(/few seconds/) });
    await a.s.stop("x");
    await done;
    const b = make({ speech: undefined as never });
    const d2 = b.s.start();
    await until(() => (b.s as unknown as { status: string }).status === "live");
    expect(await b.s.speak("hi")).toMatchObject({ ok: false, message: expect.stringMatching(/not switched on/) });
    await b.s.stop("x");
    await d2;
  }, 20_000);

  it("leaves the microphone off when it could not play, and says so", async () => {
    const page = new QuietPage();
    page.speak = async () => false;
    const { s } = make({}, page);
    const done = s.start();
    await until(() => (s as unknown as { status: string }).status === "live");
    expect(await s.speak("hello")).toMatchObject({ ok: false });
    expect(page.micCalls.at(-1)).toBe(false);
    await s.stop("x");
    await done;
  }, 20_000);

  it("waits until the room is quiet before it talks", async () => {
    const page = new QuietPage();
    const { s } = make({}, page);
    const done = s.start();
    await until(() => (s as unknown as { status: string }).status === "live");
    (s as unknown as { lastHeard: number }).lastHeard = Date.now(); // someone just spoke
    const t0 = Date.now();
    await s.speak("now");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    await s.stop("x");
    await done;
  }, 20_000);
});
