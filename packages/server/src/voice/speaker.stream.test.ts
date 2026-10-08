import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { FakeVoice, type VoiceService } from "./service";
import { Speaker } from "./speaker";

const audit = () => new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-spk-"))));
const settle = () => new Promise((r) => setTimeout(r, 30));
const spoken = (out: ServerMsg[]) =>
  out
    .filter((m): m is Extract<ServerMsg, { type: "audio.chunk" }> => m.type === "audio.chunk")
    .map((m) => Buffer.from(m.data, "base64").subarray(4).toString()); // FakeVoice answers "RIFF" + the text

function setup(voice: VoiceService = new FakeVoice()) {
  const out: ServerMsg[] = [];
  const emit = (m: ServerMsg) => out.push(m);
  return { speaker: new Speaker(voice, audit()), voice, out, emit };
}

describe("Speaker.stream", () => {
  it("speaks a sentence as soon as it is finished, before the reply is complete", async () => {
    const { speaker, voice, emit } = setup();
    const s = speaker.stream(emit);
    s.push("Good evening, boss. The weath");
    await settle();
    expect((voice as FakeVoice).synthesized).toEqual(["Good evening, boss."]); // the unfinished sentence waits
    s.push("er is nice today. ");
    await settle();
    expect((voice as FakeVoice).synthesized).toEqual(["Good evening, boss.", "The weather is nice today."]);
    await s.end();
  });

  it("says the unfinished tail when the reply ends", async () => {
    const { speaker, voice, emit } = setup();
    const s = speaker.stream(emit);
    s.push("First sentence. And then a last bit without a full stop");
    await s.end();
    expect((voice as FakeVoice).synthesized).toEqual(["First sentence.", "And then a last bit without a full stop."]);
  });

  it("keeps the order and gives every sentence its own clip id", async () => {
    const { speaker, out, emit } = setup();
    const s = speaker.stream(emit);
    for (const piece of ["One. ", "Two. ", "Three. ", "Four"]) s.push(piece);
    await s.end();
    expect(spoken(out)).toEqual(["One.", "Two.", "Three.", "Four."]);
    const ids = out.filter((m) => m.type === "audio.chunk" && m.last).map((m) => (m as { id: string }).id);
    expect(new Set(ids).size).toBe(4);
  });

  it("splits at line breaks too, and does not break a number or an abbreviation in half", async () => {
    const { speaker, voice, emit } = setup();
    const s = speaker.stream(emit);
    s.push("Today is 31.5 degrees. Ask Dr. Rao about it.\nNext line");
    await s.end();
    expect((voice as FakeVoice).synthesized).toEqual(["Today is 31.5 degrees.", "Ask Dr. Rao about it.", "Next line."]);
  });

  it("never reads a code block aloud, even when it arrives in pieces", async () => {
    const { speaker, voice, emit } = setup();
    const s = speaker.stream(emit);
    s.push("Here is the code.\n```py\nprint(1)\n");
    await settle();
    s.push("print(2)\n```\nThat is all.");
    await s.end();
    const said = (voice as FakeVoice).synthesized.join(" ");
    expect(said).toContain("Here is the code.");
    expect(said).toContain("That is all.");
    expect(said).not.toMatch(/print/);
  });

  it("drops an unclosed code block at the end instead of reading it", async () => {
    const { speaker, voice, emit } = setup();
    const s = speaker.stream(emit);
    s.push("Look at this.\n```py\nprint(1)");
    await s.end();
    expect((voice as FakeVoice).synthesized).toEqual(["Look at this."]);
  });

  it("strips markdown from what it says", async () => {
    const { speaker, voice, emit } = setup();
    const s = speaker.stream(emit);
    s.push("**Bold** and `code` here.");
    await s.end();
    expect((voice as FakeVoice).synthesized).toEqual(["Bold and code here."]);
  });

  it("says nothing for an empty reply and sends no audio", async () => {
    const { speaker, voice, out, emit } = setup();
    const s = speaker.stream(emit);
    s.push("  \n ");
    await s.end();
    expect((voice as FakeVoice).synthesized).toEqual([]);
    expect(out.filter((m) => m.type === "audio.chunk")).toEqual([]);
  });

  it("stops at once when interrupted: nothing more is synthesized or sent, later text is ignored", async () => {
    const slow = new FakeVoice();
    const real = slow.synthesize.bind(slow);
    slow.synthesize = async (t: string) => {
      await new Promise((r) => setTimeout(r, 40));
      return real(t);
    };
    const { speaker, out, emit } = setup(slow);
    const s = speaker.stream(emit);
    s.push("One. Two. Three. ");
    await new Promise((r) => setTimeout(r, 10));
    speaker.interrupt(emit);
    s.push("Four. ");
    await s.end();
    await settle();
    expect(out.some((m) => m.type === "audio.stop")).toBe(true);
    expect(spoken(out).length).toBeLessThan(2);
    expect(spoken(out)).not.toContain("Four.");
  });

  it("a newer reply replaces one that is still playing", async () => {
    const { speaker, out, emit } = setup();
    const first = speaker.stream(emit);
    first.push("Old reply that is still going. ");
    const second = speaker.stream(emit);
    expect(out.filter((m) => m.type === "audio.stop")).toHaveLength(1);
    second.push("New reply.");
    await second.end();
    await first.end();
    expect(spoken(out)).not.toContain("Old reply that is still going.");
    expect(spoken(out)).toContain("New reply.");
  });

  it("carries on with the next sentence when one cannot be synthesized", async () => {
    const flaky = new FakeVoice();
    const real = flaky.synthesize.bind(flaky);
    flaky.synthesize = async (t: string) => {
      if (t.startsWith("Bad")) throw new Error("engine hiccup C:\\secret");
      return real(t);
    };
    const { speaker, out, emit } = setup(flaky);
    const s = speaker.stream(emit);
    s.push("Bad sentence. Good sentence.");
    await s.end();
    expect(spoken(out)).toEqual(["Good sentence."]);
  });

  it("speak() still says a whole text sentence by sentence", async () => {
    const { speaker, voice, emit } = setup();
    await speaker.speak("Hello boss. All good.", emit);
    expect((voice as FakeVoice).synthesized).toEqual(["Hello boss.", "All good."]);
  });
});
