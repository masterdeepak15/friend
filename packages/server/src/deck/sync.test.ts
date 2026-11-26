import type { Deck } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { FakeVoice, type VoiceService } from "../voice/service";
import { Speaker } from "../voice/speaker";
import { Presenter } from "./presenter";

/** A mono 16-bit WAV of silence that plays for `ms`. */
function wav(ms: number, rate = 8000): Buffer {
  const data = Buffer.alloc(Math.round((rate * 2 * ms) / 1000));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const item = (id: string) => ({ id, kind: "text", content: { text: id }, say: `Say ${id} now.` });
const deck: Deck = { id: "d_1", title: "T", createdAt: 1, slides: [{ id: "s", title: "S", layout: "bullets", items: [item("a"), item("b"), item("c")] }] };

describe("a presentation with a real speaker", () => {
  it("shows the next item only when the voice has finished the one before, not as fast as the sound can be made", async () => {
    const voice = { ...new FakeVoice(), available: () => true, synthesize: async () => wav(500) } as unknown as VoiceService;
    const speaker = new Speaker(voice, new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-sync-")))));
    const shownAt: number[] = [];
    let last = 0;
    const p = new Presenter({
      speak: (t) => speaker.say(t, () => {}),
      interrupt: () => speaker.interrupt(() => {}),
      emit: (m) => {
        if (m.type !== "stage" || m.command.cmd !== "deck" || !m.command.view) return;
        if (m.command.view.shown > last && m.command.view.state === "playing") shownAt.push(Date.now());
        last = m.command.view.shown;
      },
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      resumeSilenceSeconds: () => 20,
      voiceOn: () => true,
    });
    p.start(deck);
    await new Promise((r) => setTimeout(r, 1800));
    p.control("stop");
    expect(shownAt).toHaveLength(3);
    expect(shownAt[1]! - shownAt[0]!).toBeGreaterThanOrEqual(480); // each clip is 500 ms long
    expect(shownAt[2]! - shownAt[1]!).toBeGreaterThanOrEqual(480);
  });

  it("does not end the deck while the last clip is still playing", async () => {
    const voice = { ...new FakeVoice(), available: () => true, synthesize: async () => wav(600) } as unknown as VoiceService;
    const speaker = new Speaker(voice, new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-sync2-")))));
    const states: string[] = [];
    const t0 = Date.now();
    let endedAt = 0;
    const p = new Presenter({
      speak: (t) => speaker.say(t, () => {}),
      interrupt: () => speaker.interrupt(() => {}),
      emit: (m) => {
        if (m.type === "stage" && m.command.cmd === "deck" && m.command.view?.state === "ended" && !endedAt) endedAt = Date.now();
        if (m.type === "stage" && m.command.cmd === "deck") states.push(m.command.view?.state ?? "off");
      },
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      resumeSilenceSeconds: () => 20,
      voiceOn: () => true,
    });
    p.start({ ...deck, slides: [{ ...deck.slides[0]!, items: [item("a")] }] });
    await new Promise((r) => setTimeout(r, 1200));
    p.control("stop");
    expect(endedAt - t0).toBeGreaterThanOrEqual(580); // the clip is 600 ms long
  });
});
