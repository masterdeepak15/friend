import type { ServerMsg } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { FakeVoice, type VoiceService } from "./service";
import { Speaker, chunkBase64, speechText, splitSentences } from "./speaker";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("speechText", () => {
  it("removes markdown, code blocks, links and emoji but keeps the words", () => {
    const md = "# Report\n\nHere is **bold** and `code` and a [link](https://x.example).\n\n```ts\nconst a = 1;\n```\n\n- first item\n- second item 🎉";
    const out = speechText(md);
    expect(out).toContain("Report");
    expect(out).toContain("Here is bold and code and a link.");
    expect(out).toContain("first item");
    expect(out).toContain("second item");
    expect(out).not.toMatch(/[*`#\[\]()🎉]|const a|https/);
  });
  it("ends list items and headings with a full stop so they are spoken as sentences", () => {
    expect(speechText("- one\n- two")).toBe("one. two.");
  });
  it("returns an empty string for text with nothing speakable", () => {
    expect(speechText("```js\nx\n```")).toBe("");
    expect(speechText("   \n\n ")).toBe("");
  });
});

describe("splitSentences", () => {
  it("splits on sentence ends followed by a space", () => {
    expect(splitSentences("Hello there. How are you? Fine!")).toEqual(["Hello there.", "How are you?", "Fine!"]);
  });
  it("does not split decimals or common abbreviations", () => {
    expect(splitSentences("It costs 3.5 dollars. Dr. Smith agreed.")).toEqual(["It costs 3.5 dollars.", "Dr. Smith agreed."]);
  });
  it("keeps text without punctuation as one sentence and drops punctuation-only pieces", () => {
    expect(splitSentences("no punctuation here")).toEqual(["no punctuation here"]);
    expect(splitSentences("... ?!")).toEqual([]);
  });
  it("breaks a very long sentence at commas so speech can start sooner", () => {
    const long = Array.from({ length: 40 }, (_, i) => `part number ${i}`).join(", ") + ".";
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(320);
  });
});

describe("chunkBase64", () => {
  it("splits a buffer into base64 pieces of at most the given length that reassemble exactly", () => {
    const buf = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
    const chunks = chunkBase64(buf, 48 * 1024);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(48 * 1024);
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c, "base64"))).equals(buf)).toBe(true);
  });
  it("returns a single empty chunk for an empty buffer so a clip can still be closed", () => {
    expect(chunkBase64(Buffer.alloc(0), 1000)).toEqual([""]);
  });
});

const audit = () => new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-spk-"))));

describe("Speaker", () => {
  it("synthesizes sentence by sentence and sends ordered chunks, closing each clip", async () => {
    const voice = new FakeVoice();
    const sent: ServerMsg[] = [];
    await new Speaker(voice, audit()).speak("First sentence. Second one!", (m) => sent.push(m));
    expect(voice.synthesized).toEqual(["First sentence.", "Second one!"]);
    const chunks = sent.filter((m) => m.type === "audio.chunk") as Extract<ServerMsg, { type: "audio.chunk" }>[];
    const ids = [...new Set(chunks.map((c) => c.id))];
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const mine = chunks.filter((c) => c.id === id);
      expect(mine.map((c) => c.seq)).toEqual(mine.map((_, i) => i));
      expect(mine.filter((c) => c.last)).toHaveLength(1);
      expect(mine.at(-1)!.last).toBe(true);
      expect(mine[0]!.mime).toBe("audio/wav");
    }
    expect(chunks[0]!.id).not.toBe(chunks.at(-1)!.id);
  });

  it("sends nothing for text with nothing to say", async () => {
    const voice = new FakeVoice();
    const sent: ServerMsg[] = [];
    await new Speaker(voice, audit()).speak("```x```", (m) => sent.push(m));
    expect(sent).toEqual([]);
    expect(voice.synthesized).toEqual([]);
  });

  it("skips a sentence whose synthesis fails, records it, and keeps speaking", async () => {
    let n = 0;
    const flaky: VoiceService = {
      available: () => true,
      transcribe: async () => ({ text: "", language: "en" }),
      embed: async () => ({ embedding: [1], seconds: 1 }),
      synthesize: async (t) => {
        if (n++ === 0) throw new Error("boom");
        return Buffer.from("RIFF" + t);
      },
    };
    const a = audit();
    const sent: ServerMsg[] = [];
    await new Speaker(flaky, a).speak("One. Two.", (m) => sent.push(m));
    expect(sent.filter((m) => m.type === "audio.chunk").length).toBeGreaterThan(0);
    expect(a.list(10).some((r) => r.kind === "voice.tts_failed")).toBe(true);
  });

  it("interrupt() emits audio.stop and no chunk is sent afterwards, even if synthesis finishes later", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: VoiceService = {
      available: () => true,
      transcribe: async () => ({ text: "", language: "en" }),
      embed: async () => ({ embedding: [1], seconds: 1 }),
      synthesize: async (t) => {
        await gate;
        return Buffer.from("RIFF" + t);
      },
    };
    const speaker = new Speaker(slow, audit());
    const sent: ServerMsg[] = [];
    const emit = (m: ServerMsg) => sent.push(m);
    const job = speaker.speak("One. Two. Three.", emit);
    await new Promise((r) => setTimeout(r, 20));
    speaker.interrupt(emit);
    expect(sent.at(-1)).toEqual({ type: "audio.stop" });
    release();
    await job;
    expect(sent.filter((m) => m.type === "audio.chunk")).toEqual([]);
    expect(sent.filter((m) => m.type === "audio.stop")).toHaveLength(1);
  });

  it("a new speak() interrupts the previous one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const voice: VoiceService = {
      available: () => true,
      transcribe: async () => ({ text: "", language: "en" }),
      embed: async () => ({ embedding: [1], seconds: 1 }),
      synthesize: async (t) => {
        if (first) {
          first = false;
          await gate;
        }
        return Buffer.from("RIFF" + t);
      },
    };
    const speaker = new Speaker(voice, audit());
    const sent: ServerMsg[] = [];
    const emit = (m: ServerMsg) => sent.push(m);
    const one = speaker.speak("Old reply.", emit);
    await new Promise((r) => setTimeout(r, 10));
    const two = speaker.speak("New reply.", emit);
    release();
    await Promise.all([one, two]);
    const ids = new Set((sent.filter((m) => m.type === "audio.chunk") as Extract<ServerMsg, { type: "audio.chunk" }>[]).map((c) => c.id));
    expect(ids.size).toBe(1); // only the new reply was spoken
  });
});
