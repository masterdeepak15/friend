import type { ServerMsg } from "@friend/protocol";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MusicHub } from "./hub";
import { MusicLibrary } from "./library";

const state = (over: Record<string, unknown> = {}) => ({
  playing: false,
  trackId: null,
  title: "",
  artist: "",
  album: "",
  position: 0,
  duration: 0,
  volume: 70,
  muted: false,
  shuffle: false,
  repeat: "all" as const,
  view: "mini" as const,
  queue: [],
  index: -1,
  active: false,
  ...over,
});

class Conn {
  sent: ServerMsg[] = [];
  send = (m: ServerMsg) => void this.sent.push(m);
  commands = () => this.sent.filter((m) => m.type === "music.command") as Extract<ServerMsg, { type: "music.command" }>[];
}

let lib: MusicLibrary;
let hub: MusicHub;
beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-musichub-"));
  for (const [rel, name] of [
    ["Miles Davis - So What.mp3", "x"],
    ["Miles Davis - Blue in Green.mp3", "x"],
    ["John Coltrane - Blue Train.mp3", "x"],
    ["Daft Punk - Around the World.mp3", "x"],
  ] as const) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, rel), name);
  }
  lib = new MusicLibrary({ folder: () => dir, extensions: () => ["mp3"], maxTracks: () => 100, scanDepth: () => 3 });
  await lib.scan();
  hub = new MusicHub({ library: lib });
});

describe("which screen plays", () => {
  it("says so when no Friend screen is open", () => {
    expect(hub.control({ action: "pause" })).toMatchObject({ ok: false, text: expect.stringMatching(/no friend screen is open/i) });
  });

  it("uses the screen that is active, and the newest of two that are", () => {
    const pc = new Conn();
    const phone = new Conn();
    hub.attach(pc);
    hub.attach(phone);
    hub.onState(pc, state({ active: true }), 100);
    hub.onState(phone, state({ active: true }), 200);
    hub.control({ action: "pause" });
    expect(phone.commands()).toHaveLength(1);
    expect(pc.commands()).toHaveLength(0);
    hub.onState(pc, state({ active: true }), 300);
    hub.control({ action: "resume" });
    expect(pc.commands()).toHaveLength(1);
  });

  it("falls back to the newest screen that reported anything, then to the newest connected", () => {
    const a = new Conn();
    const b = new Conn();
    hub.attach(a);
    hub.attach(b);
    hub.control({ action: "pause" });
    expect(b.commands()).toHaveLength(1); // nobody has reported: the newest connection
    hub.onState(a, state({ active: false }), 500);
    hub.control({ action: "resume" });
    expect(a.commands()).toHaveLength(1);
  });

  it("forgets a screen that disconnects", () => {
    const a = new Conn();
    hub.attach(a);
    hub.onState(a, state({ active: true, title: "X" }), 1);
    hub.detach(a);
    expect(hub.nowPlaying()).toMatchObject({ ok: false });
  });
});

describe("playing by a search", () => {
  it("sends the matching tracks to the screen, best match first, and says what it is playing", () => {
    const c = new Conn();
    hub.attach(c);
    const r = hub.play({ query: "miles davis" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/2 tracks/);
    const cmd = c.commands()[0]!;
    expect(cmd).toMatchObject({ action: "play", mode: "replace" });
    expect(cmd.tracks!.map((t) => t.title).sort()).toEqual(["Blue in Green", "So What"]);
    expect(JSON.stringify(cmd)).not.toMatch(/[A-Z]:\\|\/Users\//); // no path
  });

  it("can start shuffled, add to the queue, or play next", () => {
    const c = new Conn();
    hub.attach(c);
    hub.play({ query: "blue", shuffle: true });
    hub.play({ query: "daft", mode: "add" });
    hub.play({ query: "so what", mode: "next" });
    const [a, b, d] = c.commands();
    expect(a).toMatchObject({ shuffle: true, mode: "replace" });
    expect(b).toMatchObject({ mode: "add" });
    expect(d).toMatchObject({ mode: "next" });
  });

  it("finds by artist or album alone, and says plainly when nothing matches", () => {
    const c = new Conn();
    hub.attach(c);
    expect(hub.play({ artist: "coltrane" }).text).toMatch(/Blue Train/);
    expect(hub.play({ query: "zzz nothing" })).toMatchObject({ ok: false, text: expect.stringMatching(/no music matches/i) });
    expect(c.commands()).toHaveLength(1);
  });

  it("plays the whole library, shuffled if asked, when no search is given, and caps how many it sends", () => {
    const c = new Conn();
    hub.attach(c);
    hub.play({});
    expect(c.commands()[0]!.tracks!).toHaveLength(4);
    expect(hub.play({ limit: 2 }).text).toMatch(/2 tracks/);
  });

  it("says the library is empty, with the reason, when there is no music folder", async () => {
    const empty = new MusicHub({ library: new MusicLibrary({ folder: () => "", extensions: () => ["mp3"], maxTracks: () => 10, scanDepth: () => 2 }) });
    const c = new Conn();
    empty.attach(c);
    expect(empty.play({ query: "x" })).toMatchObject({ ok: false, text: expect.stringMatching(/no music folder|library is empty/i) });
  });
});

describe("the other controls", () => {
  it("send what they mean, checked and clamped", () => {
    const c = new Conn();
    hub.attach(c);
    expect(hub.control({ action: "volume", level: 150 }).ok).toBe(true);
    expect(hub.control({ action: "volume", delta: -20 }).ok).toBe(true);
    expect(hub.control({ action: "seek", seconds: 30 }).ok).toBe(true);
    expect(hub.control({ action: "seek", percent: 50 }).ok).toBe(true);
    expect(hub.control({ action: "mute", on: true }).ok).toBe(true);
    expect(hub.control({ action: "shuffle", on: true }).ok).toBe(true);
    expect(hub.control({ action: "repeat", mode: "one" }).ok).toBe(true);
    expect(hub.control({ action: "view", view: "full" }).ok).toBe(true);
    const sent = c.commands();
    expect(sent[0]).toMatchObject({ action: "volume", level: 100 });
    expect(sent[1]).toMatchObject({ action: "volume", delta: -20 });
    expect(sent[2]).toMatchObject({ action: "seek", seconds: 30 });
    expect(sent[3]).toMatchObject({ action: "seek", percent: 50 });
    expect(sent[5]).toMatchObject({ action: "shuffle", on: true });
    expect(sent[6]).toMatchObject({ action: "repeat", mode: "one" });
    expect(sent[7]).toMatchObject({ action: "view", view: "full" });
  });

  it("refuse what makes no sense, without sending anything", () => {
    const c = new Conn();
    hub.attach(c);
    expect(hub.control({ action: "volume" })).toMatchObject({ ok: false });
    expect(hub.control({ action: "seek" })).toMatchObject({ ok: false });
    expect(hub.control({ action: "repeat", mode: "forever" as never })).toMatchObject({ ok: false });
    expect(hub.control({ action: "explode" as never })).toMatchObject({ ok: false });
    expect(c.commands()).toHaveLength(0);
  });

  it("pause, resume, toggle, stop, next and previous go straight through", () => {
    const c = new Conn();
    hub.attach(c);
    for (const action of ["pause", "resume", "toggle", "stop", "next", "previous"] as const) expect(hub.control({ action }).ok).toBe(true);
    expect(c.commands().map((m) => m.action)).toEqual(["pause", "resume", "toggle", "stop", "next", "previous"]);
  });
});

describe("the queue", () => {
  it("adds by search, removes by number, clears, and shows what the screen last said", () => {
    const c = new Conn();
    hub.attach(c);
    expect(hub.queue({ action: "add", query: "daft" }).ok).toBe(true);
    expect(c.commands()[0]).toMatchObject({ action: "play", mode: "add" });
    expect(hub.queue({ action: "remove", index: 2 }).ok).toBe(true);
    expect(c.commands()[1]).toMatchObject({ action: "queue.remove", index: 1 }); // the owner counts from 1
    expect(hub.queue({ action: "clear" }).ok).toBe(true);
    hub.onState(c, state({ active: true, index: 1, queue: [{ id: "a", title: "One" }, { id: "b", title: "Two" }] }), 1);
    const shown = hub.queue({ action: "show" });
    expect(shown.text).toMatch(/1\. One/);
    expect(shown.text).toMatch(/2\. Two \(playing\)/);
  });
});

describe("what is playing and what can be played", () => {
  it("describes the player in plain words", () => {
    const c = new Conn();
    hub.attach(c);
    hub.onState(c, state({ active: true, playing: true, title: "So What", artist: "Miles Davis", album: "Kind of Blue", position: 61, duration: 562, volume: 40, shuffle: true, repeat: "one", queue: [{ id: "a", title: "x" }, { id: "b", title: "y" }], index: 0 }), 1);
    const r = hub.nowPlaying();
    expect(r.ok).toBe(true);
    expect(r.text).toContain("So What by Miles Davis");
    expect(r.text).toMatch(/1:01 of 9:22/);
    expect(r.text).toMatch(/volume 40/i);
    expect(r.text).toMatch(/shuffle on/);
    expect(r.text).toMatch(/repeat one/);
    hub.onState(c, state({ active: true }), 2);
    expect(hub.nowPlaying().text).toMatch(/nothing is playing/i);
  });

  it("searches without needing a screen, and never lists paths", () => {
    const r = hub.search({ query: "blue" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/2 tracks/);
    expect(r.text).toContain("Blue Train");
    expect(r.text).not.toMatch(/[A-Z]:\\|\.mp3/);
    expect(hub.search({ query: "nothing here" })).toMatchObject({ ok: true, text: expect.stringMatching(/no music matches/i) });
  });
});
