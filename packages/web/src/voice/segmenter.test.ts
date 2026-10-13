import { describe, expect, it } from "vitest";
import { Segmenter } from "./segmenter";

/** Feeds `level` every 50 ms for `ms` and returns what the segmenter reported. */
function run(seg: Segmenter, start: number, ms: number, level: number) {
  const out: { at: number; ev: string }[] = [];
  for (let t = start; t < start + ms; t += 50) {
    const ev = seg.feed(level, t);
    if (ev) out.push({ at: t, ev: ev.type });
  }
  return out;
}

describe("cutting the microphone into things said", () => {
  it("reports the start after a quarter second of speech and the end after a quiet pause", () => {
    const seg = new Segmenter();
    run(seg, 0, 1000, 0.01); // a quiet room
    const speech = run(seg, 1000, 1500, 0.2);
    expect(speech.map((e) => e.ev)).toEqual(["start"]);
    expect(speech[0]!.at).toBeGreaterThanOrEqual(1250);
    const after = run(seg, 2500, 1500, 0.01);
    expect(after.map((e) => e.ev)).toEqual(["end"]);
    expect(after[0]!.at).toBeGreaterThanOrEqual(2450 + 800);
  });

  it("ignores a click or a cough shorter than a quarter second", () => {
    const seg = new Segmenter();
    run(seg, 0, 1000, 0.01);
    expect(run(seg, 1000, 150, 0.3)).toEqual([]);
    expect(run(seg, 1150, 2000, 0.01)).toEqual([]);
  });

  it("does not end on a short breath between words", () => {
    const seg = new Segmenter();
    run(seg, 0, 500, 0.01);
    run(seg, 500, 1000, 0.2);
    expect(run(seg, 1500, 400, 0.01)).toEqual([]); // a pause for breath
    expect(run(seg, 1900, 500, 0.2)).toEqual([]);
    expect(run(seg, 2400, 1000, 0.01).map((e) => e.ev)).toEqual(["end"]);
  });

  it("ends a long speech at the longest allowed time", () => {
    const seg = new Segmenter({ maxMs: 5000 });
    run(seg, 0, 500, 0.01);
    const ev = run(seg, 500, 8000, 0.2);
    expect(ev.map((e) => e.ev)).toEqual(["start", "end"]);
    expect(ev[1]!.at).toBeLessThanOrEqual(5700);
  });

  it("learns how loud the room is, so a steady hum is not speech", () => {
    const seg = new Segmenter();
    expect(run(seg, 0, 10_000, 0.05)).toEqual([]); // a fan: constant, so it becomes the floor
  });

  it("still hears quiet speech from across the room", () => {
    const seg = new Segmenter();
    run(seg, 0, 2000, 0.005);
    expect(run(seg, 2000, 1000, 0.05).map((e) => e.ev)).toEqual(["start"]);
  });

  it("reports how long it was and how much of it was speech", () => {
    const seg = new Segmenter();
    run(seg, 0, 500, 0.01);
    run(seg, 500, 1000, 0.2);
    let end: { type: string; speechMs?: number; ms?: number } | null = null;
    for (let t = 1500; t < 3000 && !end; t += 50) {
      const e = seg.feed(0.01, t);
      if (e?.type === "end") end = e;
    }
    expect(end).toMatchObject({ type: "end" });
    expect(end!.speechMs).toBeGreaterThanOrEqual(900);
  });

  it("can be told to start over", () => {
    const seg = new Segmenter();
    run(seg, 0, 500, 0.01);
    run(seg, 500, 600, 0.2);
    seg.reset();
    expect(run(seg, 1100, 2000, 0.01)).toEqual([]);
  });
});
