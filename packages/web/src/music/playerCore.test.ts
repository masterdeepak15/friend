import { describe, expect, it } from "vitest";
import { initialPlayer, playerReducer, type PlayerState, type Track } from "./playerCore";

const t = (n: number): Track => ({ id: String(n).padStart(16, "0"), title: `Song ${n}`, artist: "A", album: "B", durationSec: 100 + n });
const tracks = (n: number) => Array.from({ length: n }, (_, i) => t(i + 1));
const run = (s: PlayerState, ...actions: Parameters<typeof playerReducer>[1][]) => actions.reduce((state, a) => playerReducer(state, a), s);
const start = () => initialPlayer({ volume: 70, shuffle: false, repeat: "all", view: "mini" });

describe("playing a list", () => {
  it("replaces the queue and starts at the first track", () => {
    const s = run(start(), { type: "play", tracks: tracks(3), mode: "replace" });
    expect(s.queue.map((x) => x.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
    expect(s).toMatchObject({ index: 0, playing: true, position: 0 });
  });

  it("can start at a chosen track", () => {
    const s = run(start(), { type: "play", tracks: tracks(5), mode: "replace", start: 3 });
    expect(s.index).toBe(3);
  });

  it("shuffled keeps every track once and starts playing", () => {
    const s = run(start(), { type: "play", tracks: tracks(20), mode: "replace", shuffle: true });
    expect(s.queue.map((x) => x.id).sort()).toEqual(tracks(20).map((x) => x.id).sort());
    expect(s).toMatchObject({ index: 0, playing: true, shuffle: true });
  });

  it("adds to the end without disturbing what is playing", () => {
    const s = run(start(), { type: "play", tracks: tracks(2), mode: "replace" }, { type: "play", tracks: [t(9)], mode: "add" });
    expect(s.queue.map((x) => x.title)).toEqual(["Song 1", "Song 2", "Song 9"]);
    expect(s.index).toBe(0);
  });

  it("plays next: right after the current track", () => {
    const s = run(start(), { type: "play", tracks: tracks(3), mode: "replace" }, { type: "play", tracks: [t(9)], mode: "next" });
    expect(s.queue.map((x) => x.title)).toEqual(["Song 1", "Song 9", "Song 2", "Song 3"]);
  });

  it("add on an empty queue starts it, and an empty list changes nothing", () => {
    const s = run(start(), { type: "play", tracks: [t(1)], mode: "add" });
    expect(s).toMatchObject({ index: 0, playing: true });
    expect(run(s, { type: "play", tracks: [], mode: "replace" })).toBe(s);
  });

  it("does not hold more than 2000 tracks", () => {
    const s = run(start(), { type: "play", tracks: tracks(3000), mode: "replace" });
    expect(s.queue).toHaveLength(2000);
  });
});

describe("next and previous", () => {
  const three = () => run(start(), { type: "play", tracks: tracks(3), mode: "replace" });

  it("moves along, and wraps when repeat is all", () => {
    expect(run(three(), { type: "next" }).index).toBe(1);
    expect(run(three(), { type: "next" }, { type: "next" }, { type: "next" })).toMatchObject({ index: 0, playing: true });
  });

  it("stops at the end when repeat is off", () => {
    const s = run(three(), { type: "repeat", mode: "off" }, { type: "next" }, { type: "next" }, { type: "next" });
    expect(s).toMatchObject({ index: 2, playing: false });
  });

  it("previous goes back, or restarts the track when it has played for a while", () => {
    const s = run(three(), { type: "next" }, { type: "next" });
    expect(run(s, { type: "previous" }).index).toBe(1);
    expect(run(s, { type: "time", position: 10, duration: 100 }, { type: "previous" })).toMatchObject({ index: 2, position: 0 });
  });

  it("previous at the start wraps with repeat all, and stays with repeat off", () => {
    expect(run(three(), { type: "previous" }).index).toBe(2);
    expect(run(three(), { type: "repeat", mode: "off" }, { type: "previous" })).toMatchObject({ index: 0, position: 0 });
  });
});

describe("when a track ends", () => {
  const three = () => run(start(), { type: "play", tracks: tracks(3), mode: "replace" });

  it("moves on, repeats one, or stops at the end", () => {
    expect(run(three(), { type: "ended" }).index).toBe(1);
    expect(run(three(), { type: "repeat", mode: "one" }, { type: "ended" })).toMatchObject({ index: 0, position: 0, playing: true });
    const last = run(three(), { type: "repeat", mode: "off" }, { type: "ended" }, { type: "ended" }, { type: "ended" });
    expect(last).toMatchObject({ index: 2, playing: false });
  });
});

describe("the other controls", () => {
  const playing = () => run(start(), { type: "play", tracks: tracks(4), mode: "replace" });

  it("pause, resume, toggle and stop", () => {
    expect(run(playing(), { type: "pause" }).playing).toBe(false);
    expect(run(playing(), { type: "pause" }, { type: "resume" }).playing).toBe(true);
    expect(run(playing(), { type: "toggle" }).playing).toBe(false);
    expect(run(playing(), { type: "stop" })).toMatchObject({ playing: false, position: 0 });
  });

  it("resume with nothing queued does nothing", () => {
    expect(run(start(), { type: "resume" }).playing).toBe(false);
  });

  it("volume is clamped, steps, and mute toggles or is set", () => {
    expect(run(start(), { type: "volume", level: 150 }).volume).toBe(100);
    expect(run(start(), { type: "volume", level: -5 }).volume).toBe(0);
    expect(run(start(), { type: "volume", delta: -20 }).volume).toBe(50);
    expect(run(start(), { type: "volume", delta: 50 }).volume).toBe(100);
    expect(run(start(), { type: "mute" }).muted).toBe(true);
    expect(run(start(), { type: "mute" }, { type: "mute" }).muted).toBe(false);
    expect(run(start(), { type: "mute", on: true }, { type: "mute", on: true }).muted).toBe(true);
    expect(run(start(), { type: "mute", on: true }, { type: "volume", level: 30 }).muted).toBe(false); // changing the volume un-mutes
  });

  it("seek by seconds or percent stays inside the track", () => {
    const s = run(playing(), { type: "time", position: 0, duration: 200 });
    expect(run(s, { type: "seek", seconds: 50 }).position).toBe(50);
    expect(run(s, { type: "seek", percent: 25 }).position).toBe(50);
    expect(run(s, { type: "seek", seconds: 999 }).position).toBe(200);
    expect(run(s, { type: "seek", seconds: -5 }).position).toBe(0);
  });

  it("repeat and view are set, and shuffle reorders only what is still to come", () => {
    expect(run(start(), { type: "repeat", mode: "one" }).repeat).toBe("one");
    expect(run(start(), { type: "view", view: "full" }).view).toBe("full");
    const s = run(playing(), { type: "next" }, { type: "shuffle", on: true });
    expect(s.shuffle).toBe(true);
    expect(s.queue.slice(0, 2).map((x) => x.title)).toEqual(["Song 1", "Song 2"]); // what was played and what is playing stay put
    expect(s.queue.slice(2).map((x) => x.id).sort()).toEqual([t(3).id, t(4).id].sort());
    expect(run(s, { type: "shuffle" }).shuffle).toBe(false);
  });
});

describe("the queue", () => {
  const four = () => run(start(), { type: "play", tracks: tracks(4), mode: "replace" });

  it("removes a track before the current one by moving the index back with it", () => {
    const s = run(four(), { type: "next" }, { type: "next" }, { type: "remove", index: 0 });
    expect(s.queue.map((x) => x.title)).toEqual(["Song 2", "Song 3", "Song 4"]);
    expect(s.index).toBe(1);
    expect(s.queue[s.index]!.title).toBe("Song 3");
  });

  it("removing the playing track moves on to the next one, and removing the last one empties and stops", () => {
    const s = run(four(), { type: "remove", index: 0 });
    expect(s.queue[s.index]!.title).toBe("Song 2");
    expect(s.playing).toBe(true);
    const one = run(start(), { type: "play", tracks: [t(1)], mode: "replace" }, { type: "remove", index: 0 });
    expect(one).toMatchObject({ queue: [], index: -1, playing: false });
  });

  it("ignores a number that is not in the queue, and clear empties and stops", () => {
    expect(run(four(), { type: "remove", index: 99 }).queue).toHaveLength(4);
    expect(run(four(), { type: "clear" })).toMatchObject({ queue: [], index: -1, playing: false });
  });

  it("jumps to a chosen track", () => {
    expect(run(four(), { type: "jump", index: 2 })).toMatchObject({ index: 2, playing: true, position: 0 });
    expect(run(four(), { type: "jump", index: 9 }).index).toBe(0);
  });
});

describe("what the reducer reports", () => {
  it("time updates keep the position and length, and a failed track moves on", () => {
    const s = run(start(), { type: "play", tracks: tracks(2), mode: "replace" }, { type: "time", position: 12.5, duration: 99 });
    expect(s).toMatchObject({ position: 12.5, duration: 99 });
    expect(run(s, { type: "failed" }).index).toBe(1);
  });

  it("shuffle uses the shuffle given, so a test can be exact", () => {
    const s = playerReducer(start(), { type: "play", tracks: tracks(3), mode: "replace", shuffle: true }, { shuffle: <T,>(items: T[]) => [...items].reverse() });
    expect(s.queue.map((x) => x.title)).toEqual(["Song 3", "Song 2", "Song 1"]);
  });
});
