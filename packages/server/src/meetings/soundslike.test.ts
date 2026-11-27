import { describe, expect, it } from "vitest";
import { isAddressed, soundsLike } from "./logic";
import { AudioHearing } from "./hearing";
import { MeetingSession, type MeetingPage, type Phase } from "./session";
import { DEFAULT_PREFS } from "./store";
import type { CaptionItem, Line } from "./logic";

describe("a name a speech engine garbled", () => {
  it("is still taken as the assistant being called, but only for audio", () => {
    const line = { speaker: "Someone", text: "Umayyad, can you tell me hacking related news?" };
    expect(isAddressed(line, ["Maya"], "Maya")).toBe(false); // captions are exact: not a call
    expect(isAddressed(line, ["Maya"], "Maya", true)).toBe(true);
    for (const said of ["Maia, are you there?", "Mayaa what do you think", "hey Mayah", "okay umaya go on"]) expect(soundsLike(said, ["Maya"])).toBe(true);
  });

  it("does not take ordinary words for a name, nor match short names", () => {
    for (const said of ["Let us meet in May", "the map is ready", "maybe tomorrow", "Mayor said it"]) expect(soundsLike(said, ["Maya"])).toBe(false);
    expect(soundsLike("Ben is here", ["Bo"])).toBe(false);
    expect(soundsLike("a bat flew", ["Ben"])).toBe(false);
  });
});

const RATE = 16000;
const speech = (s: number) => {
  const b = Buffer.alloc(Math.floor(s * RATE) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * 9000), i * 2);
  return b;
};

class EchoPage implements MeetingPage {
  heard = 0;
  sound: Buffer[] = [];
  async open() {}
  async advance() {
    return { phase: "in" as Phase, detail: "" };
  }
  async captions(): Promise<CaptionItem[] | null> {
    return null;
  }
  async enableCaptions() {}
  async chat() {
    return true;
  }
  async leave() {}
  async close() {}
  async mic() {
    return true;
  }
  async speak() {
    // while it talks, its own voice comes back in the call sound
    this.sound.push(Buffer.concat([speech(5), Buffer.alloc(16000 * 2)]));
    await new Promise((r) => setTimeout(r, 120));
    return true;
  }
  async audio() {
    this.heard++;
    return this.sound.shift() ?? Buffer.alloc(0);
  }
}

describe("its own voice coming back", () => {
  it("is not listened to while it speaks", async () => {
    const page = new EchoPage();
    const texts: string[] = [];
    const lines: Line[] = [];
    const s = new MeetingSession({
      page,
      url: "https://teams.live.com/meet/1",
      selfName: "Maya",
      names: () => ["Maya"],
      prefs: () => DEFAULT_PREFS,
      announcement: "hi",
      pollMs: 5,
      speech: async () => Buffer.from("RIFF"),
      hearing: new AudioHearing({ transcribe: async () => (texts.push("heard"), "You are welcome") }),
      events: { status: () => {}, lines: (l) => lines.push(...l), addressed: () => {}, ownerRelevant: () => {}, notesDue: () => {}, problem: () => {}, ended: () => {} },
    });
    const done = s.start();
    const until = async (c: () => boolean) => {
      for (let t = 0; t < 8000 && !c(); t += 10) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => (s as unknown as { audioMode: boolean }).audioMode);
    await new Promise((r) => setTimeout(r, 100));
    expect((await s.speak("It is on track.")).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 400)); // the 3 seconds after are not over: still deaf
    expect(texts).toEqual([]);
    expect(lines).toEqual([]);
    await s.stop("x");
    await done;
  }, 20_000);
});
describe("who is talking, when the voice is recognised", () => {
  it("names the speaker the voice engine recognised and calls everyone else Someone", async () => {
    const said: { speaker: string; text: string }[] = [];
    let n = 0;
    const h = new AudioHearing({ transcribe: async () => (n++ === 0 ? { text: "Maya, are you there?", speaker: "Deepak" } : { text: "Hello everyone" }) });
    for (let i = 0; i < 2; i++) {
      h.push(speech(3));
      h.push(Buffer.alloc(16000 * 2));
    }
    await h.finish();
    said.push(...h.take());
    expect(said).toEqual([
      { speaker: "Deepak", text: "Maya, are you there?" },
      { speaker: "Someone", text: "Hello everyone" },
    ]);
  });
});
