import type { MusicCommand, ServerMsg } from "@friend/protocol";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MusicHub } from "./hub";
import { MusicLibrary } from "./library";
import { LocalSource, MusicSources, type MusicSource } from "./source";

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
  it("says so when no Friend screen is open", async () => {
    expect(await hub.control({ action: "pause" })).toMatchObject({ ok: false, text: expect.stringMatching(/no friend screen is open/i) });
  });

  it("uses the screen that is active, and the newest of two that are", async () => {
    const pc = new Conn();
    const phone = new Conn();
    hub.attach(pc);
    hub.attach(phone);
    hub.onState(pc, state({ active: true }), 100);
    hub.onState(phone, state({ active: true }), 200);
    await hub.control({ action: "pause" });
    expect(phone.commands()).toHaveLength(1);
    expect(pc.commands()).toHaveLength(0);
    hub.onState(pc, state({ active: true }), 300);
    await hub.control({ action: "resume" });
    expect(pc.commands()).toHaveLength(1);
  });

  it("falls back to the newest screen that reported anything, then to the newest connected", async () => {
    const a = new Conn();
    const b = new Conn();
    hub.attach(a);
    hub.attach(b);
    await hub.control({ action: "pause" });
    expect(b.commands()).toHaveLength(1); // nobody has reported: the newest connection
    hub.onState(a, state({ active: false }), 500);
    await hub.control({ action: "resume" });
    expect(a.commands()).toHaveLength(1);
  });

  it("forgets a screen that disconnects", async () => {
    const a = new Conn();
    hub.attach(a);
    hub.onState(a, state({ active: true, title: "X" }), 1);
    hub.detach(a);
    expect(hub.nowPlaying()).toMatchObject({ ok: false });
  });
});

describe("playing by a search", () => {
  it("sends the matching tracks to the screen, best match first, and says what it is playing", async () => {
    const c = new Conn();
    hub.attach(c);
    const r = await hub.play({ query: "miles davis" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/2 tracks/);
    const cmd = c.commands()[0]!;
    expect(cmd).toMatchObject({ action: "play", mode: "replace" });
    expect(cmd.tracks!.map((t) => t.title).sort()).toEqual(["Blue in Green", "So What"]);
    expect(JSON.stringify(cmd)).not.toMatch(/[A-Z]:\\|\/Users\//); // no path
  });

  it("can start shuffled, add to the queue, or play next", async () => {
    const c = new Conn();
    hub.attach(c);
    await hub.play({ query: "blue", shuffle: true });
    await hub.play({ query: "daft", mode: "add" });
    await hub.play({ query: "so what", mode: "next" });
    const [a, b, d] = c.commands();
    expect(a).toMatchObject({ shuffle: true, mode: "replace" });
    expect(b).toMatchObject({ mode: "add" });
    expect(d).toMatchObject({ mode: "next" });
  });

  it("finds by artist or album alone, and says plainly when nothing matches", async () => {
    const c = new Conn();
    hub.attach(c);
    expect((await hub.play({ artist: "coltrane" })).text).toMatch(/Blue Train/);
    expect(await hub.play({ query: "zzz nothing" })).toMatchObject({ ok: false, text: expect.stringMatching(/no music matches/i) });
    expect(c.commands()).toHaveLength(1);
  });

  it("plays the whole library, shuffled if asked, when no search is given, and caps how many it sends", async () => {
    const c = new Conn();
    hub.attach(c);
    await hub.play({});
    expect(c.commands()[0]!.tracks!).toHaveLength(4);
    expect((await hub.play({ limit: 2 })).text).toMatch(/2 tracks/);
  });

  it("says the library is empty, with the reason, when there is no music folder", async () => {
    const empty = new MusicHub({ library: new MusicLibrary({ folder: () => "", extensions: () => ["mp3"], maxTracks: () => 10, scanDepth: () => 2 }) });
    const c = new Conn();
    empty.attach(c);
    expect(await empty.play({ query: "x" })).toMatchObject({ ok: false, text: expect.stringMatching(/no music folder|library is empty/i) });
  });
});

describe("the other controls", () => {
  it("send what they mean, checked and clamped", async () => {
    const c = new Conn();
    hub.attach(c);
    expect((await hub.control({ action: "volume", level: 150 })).ok).toBe(true);
    expect((await hub.control({ action: "volume", delta: -20 })).ok).toBe(true);
    expect((await hub.control({ action: "seek", seconds: 30 })).ok).toBe(true);
    expect((await hub.control({ action: "seek", percent: 50 })).ok).toBe(true);
    expect((await hub.control({ action: "mute", on: true })).ok).toBe(true);
    expect((await hub.control({ action: "shuffle", on: true })).ok).toBe(true);
    expect((await hub.control({ action: "repeat", mode: "one" })).ok).toBe(true);
    expect((await hub.control({ action: "view", view: "full" })).ok).toBe(true);
    const sent = c.commands();
    expect(sent[0]).toMatchObject({ action: "volume", level: 100 });
    expect(sent[1]).toMatchObject({ action: "volume", delta: -20 });
    expect(sent[2]).toMatchObject({ action: "seek", seconds: 30 });
    expect(sent[3]).toMatchObject({ action: "seek", percent: 50 });
    expect(sent[5]).toMatchObject({ action: "shuffle", on: true });
    expect(sent[6]).toMatchObject({ action: "repeat", mode: "one" });
    expect(sent[7]).toMatchObject({ action: "view", view: "full" });
  });

  it("refuse what makes no sense, without sending anything", async () => {
    const c = new Conn();
    hub.attach(c);
    expect(await hub.control({ action: "volume" })).toMatchObject({ ok: false });
    expect(await hub.control({ action: "seek" })).toMatchObject({ ok: false });
    expect(await hub.control({ action: "repeat", mode: "forever" as never })).toMatchObject({ ok: false });
    expect(await hub.control({ action: "explode" as never })).toMatchObject({ ok: false });
    expect(c.commands()).toHaveLength(0);
  });

  it("pause, resume, toggle, stop, next and previous go straight through", async () => {
    const c = new Conn();
    hub.attach(c);
    for (const action of ["pause", "resume", "toggle", "stop", "next", "previous"] as const) expect((await hub.control({ action })).ok).toBe(true);
    expect(c.commands().map((m) => m.action)).toEqual(["pause", "resume", "toggle", "stop", "next", "previous"]);
  });
});

describe("the queue", () => {
  it("adds by search, removes by number, clears, and shows what the screen last said", async () => {
    const c = new Conn();
    hub.attach(c);
    expect((await hub.queue({ action: "add", query: "daft" })).ok).toBe(true);
    expect(c.commands()[0]).toMatchObject({ action: "play", mode: "add" });
    expect((await hub.queue({ action: "remove", index: 2 })).ok).toBe(true);
    expect(c.commands()[1]).toMatchObject({ action: "queue.remove", index: 1 }); // the owner counts from 1
    expect((await hub.queue({ action: "clear" })).ok).toBe(true);
    hub.onState(c, state({ active: true, index: 1, queue: [{ id: "a", title: "One" }, { id: "b", title: "Two" }] }), 1);
    const shown = await hub.queue({ action: "show" });
    expect(shown.text).toMatch(/1\. One/);
    expect(shown.text).toMatch(/2\. Two \(playing\)/);
  });
});

describe("what is playing and what can be played", () => {
  it("describes the player in plain words", async () => {
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

  it("searches without needing a screen, and never lists paths", async () => {
    const r = await hub.search({ query: "blue" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/2 tracks/);
    expect(r.text).toContain("Blue Train");
    expect(r.text).not.toMatch(/[A-Z]:\\|\.mp3/);
    expect(await hub.search({ query: "nothing here" })).toMatchObject({ ok: true, text: expect.stringMatching(/no music matches/i) });
  });
});

describe("playing from other sources", () => {
  const spotTracks = [
    { ref: "spotify:4uLU6hMCjMI75M1A2tKUQC", source: "spotify" as const, title: "Never Gonna Give You Up", artist: "Rick Astley", album: "WNYSB", durationSec: 213 },
    { ref: "spotify:7qiZfU4dY1lWllzX7mPBI3", source: "spotify" as const, title: "Shape of You", artist: "Ed Sheeran", album: "Divide", durationSec: 233 },
  ];
  const spotify = (status: { connected: boolean; needs: string | null; canPlay?: boolean } = { connected: true, needs: null }) => ({
    id: "spotify" as const,
    status: () => ({ ...status, account: "me" }),
    search: async () => spotTracks,
    playlists: async () => [],
    tracksOf: async () => [],
    track: async () => null,
  });
  const make = (s: MusicSource = spotify(), defaultSource: "local" | "spotify" | "any" = "local") => {
    const sources = new MusicSources([new LocalSource(lib), s], { defaultSource: () => defaultSource, searchLimit: () => 10 });
    const h = new MusicHub({ library: lib, sources });
    const c = new Conn();
    h.attach(c);
    return { h, c };
  };

  it("plays Spotify tracks by their ref when asked", async () => {
    const { h, c } = make();
    const r = await h.play({ query: "never", source: "spotify" });
    expect(r.ok).toBe(true);
    expect(c.commands()[0]).toMatchObject({ action: "play", mode: "replace", tracks: [{ id: "spotify:4uLU6hMCjMI75M1A2tKUQC", title: "Never Gonna Give You Up" }, { id: "spotify:7qiZfU4dY1lWllzX7mPBI3" }] });
    expect(r.text).toMatch(/Never Gonna Give You Up/);
  });

  it("uses the owner's default source when none is named", async () => {
    const { h, c } = make(spotify(), "spotify");
    await h.play({ query: "never" });
    expect(c.commands()[0]!.tracks![0]!.id).toBe("spotify:4uLU6hMCjMI75M1A2tKUQC");
  });

  it("the folder still plays with bare ids and up to 200 tracks, whatever the search limit", async () => {
    const { h, c } = make(spotify(), "local");
    await h.play({ query: "miles" });
    expect(c.commands()[0]!.tracks!.map((t) => t.id).every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(c.commands()[0]!.tracks).toHaveLength(2);
  });

  it("any: the folder's tracks keep bare ids next to Spotify's refs", async () => {
    const { h, c } = make(spotify(), "any");
    await h.play({ query: "miles", source: "any" });
    const ids = c.commands()[0]!.tracks!.map((t) => t.id);
    expect(ids.some((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
    expect(ids.some((id) => id.startsWith("spotify:"))).toBe(true);
  });

  it("a Spotify that is not connected says what to do, and nothing is sent", async () => {
    const { h, c } = make(spotify({ connected: false, needs: "Connect your Spotify account in Plugins, Spotify." }));
    const r = await h.play({ query: "never", source: "spotify" });
    expect(r).toEqual({ ok: false, text: expect.stringContaining("Connect your Spotify account") });
    expect(c.commands()).toHaveLength(0);
  });

  it("a free Spotify account can search but is told it cannot play, and nothing is sent", async () => {
    const { h, c } = make(spotify({ connected: true, needs: "Spotify Premium is needed to play (searching works).", canPlay: false }));
    const r = await h.play({ query: "never", source: "spotify" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/Premium/);
    expect(c.commands()).toHaveLength(0);
    const found = await h.search({ query: "never", source: "spotify" });
    expect(found.ok).toBe(true);
    expect(found.text).toMatch(/Never Gonna Give You Up/);
  });

  it("any with a free Spotify plays the folder's tracks only and says why Spotify was left out", async () => {
    const { h, c } = make(spotify({ connected: true, needs: "Spotify Premium is needed to play (searching works).", canPlay: false }), "any");
    const r = await h.play({ query: "miles", source: "any" });
    expect(r.ok).toBe(true);
    expect(c.commands()[0]!.tracks!.every((t) => /^[0-9a-f]{16}$/.test(t.id))).toBe(true);
    expect(r.text).toMatch(/Premium/);
  });

  it("search lists each track with where it comes from", async () => {
    const { h } = make();
    const r = await h.search({ query: "never", source: "spotify" });
    expect(r.text).toMatch(/Never Gonna Give You Up — Rick Astley.*Spotify/);
  });

  it("add to the queue takes the source too", async () => {
    const { h, c } = make();
    await h.queue({ action: "add", query: "never", source: "spotify" });
    expect(c.commands()[0]).toMatchObject({ action: "play", mode: "add" });
  });

  it("play my music with no words plays the whole folder (up to 200) even when the default is Spotify or both", async () => {
    for (const d of ["spotify", "any"] as const) {
      const { h, c } = make(spotify(), d);
      const r = await h.play({});
      expect(r.ok, d).toBe(true);
      expect(c.commands()[0]!.tracks!.length, d).toBe(4);
      expect(c.commands()[0]!.tracks!.every((t) => /^[0-9a-f]{16}$/.test(t.id)), d).toBe(true);
    }
  });

  it("asking for Spotify with no words says to name something, and does not call Spotify", async () => {
    const calls: string[] = [];
    const s = { ...spotify(), search: async (q: string): Promise<typeof spotTracks> => { calls.push(q); return []; } };
    const { h, c } = make(s);
    const r = await h.play({ source: "spotify" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/say what to play/i);
    expect(calls).toHaveLength(0);
    expect(c.commands()).toHaveLength(0);
  });

  it("an error from a source is one plain sentence and sends nothing", async () => {
    const boom = { ...spotify(), search: async () => { throw new Error("token AT-1 leaked"); } };
    const { h, c } = make(boom);
    const r = await h.play({ query: "x", source: "spotify" });
    expect(r.ok).toBe(false);
    expect(r.text).not.toMatch(/AT-1/);
    expect(c.commands()).toHaveLength(0);
  });
});

describe("with the PC as the output", () => {
  class FakeHost {
    commands: MusicCommand[] = [];
    result: { ok: boolean; text: string } = { ok: true, text: "Done." };
    availableNow: { ok: true } | { ok: false; reason: string } = { ok: true };
    stateNow = state({ playing: true, trackId: "0000000000000001", title: "So What", artist: "Miles Davis", album: "Kind of Blue", position: 65, duration: 540, queue: [{ id: "a", title: "So What" }, { id: "b", title: "Blue in Green" }], index: 0 });
    async command(c: MusicCommand) {
      this.commands.push(c);
      return this.result;
    }
    state() {
      return this.stateNow;
    }
    available() {
      return this.availableNow;
    }
    lastError(): string | null {
      return null;
    }
  }
  let host: FakeHost;
  let output: "screen" | "host";
  let screen: Conn;
  let h: MusicHub;
  beforeEach(() => {
    host = new FakeHost();
    output = "host";
    screen = new Conn();
    h = new MusicHub({ library: lib, host: host as never, output: () => output });
    h.attach(screen);
  });

  it("sends play to the PC, not to the screen, and says where it plays", async () => {
    const r = await h.play({ query: "miles" });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/on this PC/);
    expect(host.commands[0]).toMatchObject({ action: "play", mode: "replace" });
    expect(host.commands[0]!.tracks!.every((t) => /^[0-9a-f]{16}$/.test(t.id))).toBe(true);
    expect(screen.commands()).toHaveLength(0);
  });

  it("controls and queue edits go to the PC too", async () => {
    await h.control({ action: "pause" });
    await h.control({ action: "volume", level: 30 });
    await h.queue({ action: "remove", index: 2 });
    await h.queue({ action: "clear" });
    expect(host.commands.map((c) => c.action)).toEqual(["pause", "volume", "queue.remove", "queue.clear"]);
    expect(screen.commands()).toHaveLength(0);
  });

  it("works with no screen open at all", async () => {
    h.detach(screen);
    expect((await h.play({ query: "miles" })).ok).toBe(true);
    expect((await h.control({ action: "pause" })).ok).toBe(true);
  });

  it("when the PC cannot play, the reason comes back and nothing goes to any screen", async () => {
    host.availableNow = { ok: false, reason: "The player program set in Settings cannot be used." };
    const r = await h.play({ query: "miles" });
    expect(r).toEqual({ ok: false, text: expect.stringContaining("player program") });
    expect(host.commands).toHaveLength(0);
    expect(screen.commands()).toHaveLength(0);
  });

  it("an error from the PC's player (mpv missing) is passed on as it is", async () => {
    host.result = { ok: false, text: "mpv is not installed. Install it once with: winget install mpv, then try again." };
    const r = await h.play({ query: "miles" });
    expect(r).toEqual({ ok: false, text: expect.stringContaining("winget install mpv") });
    expect(screen.commands()).toHaveLength(0);
  });

  it("says what is playing and shows the queue from the PC's player", async () => {
    expect(h.nowPlaying().text).toMatch(/Playing: So What by Miles Davis.*1:05 of 9:00/);
    expect((await h.queue({ action: "show" })).text).toMatch(/2 tracks.*1\. So What \(playing\).*2\. Blue in Green/s);
  });

  it("the view (mini, full, hidden) is the screen's business: it goes to the screens, not the PC", async () => {
    const r = await h.control({ action: "view", view: "full" });
    expect(r.ok).toBe(true);
    expect(screen.commands()).toEqual([expect.objectContaining({ action: "view", view: "full" })]);
    expect(host.commands).toHaveLength(0);
  });

  it("a title with a full stop in it is not cut in two, and the reply says where it plays", async () => {
    const sources = new MusicSources([new LocalSource(lib), { id: "spotify" as const, status: () => ({ connected: true, needs: null, account: "me" }), search: async () => [{ ref: "spotify:4uLU6hMCjMI75M1A2tKUQC", source: "spotify" as const, title: "Mr. Brightside", artist: "The Killers", album: "Hot Fuss", durationSec: 222 }], playlists: async () => [], tracksOf: async () => [], track: async () => null }], { defaultSource: () => "spotify", searchLimit: () => 10 });
    const hh = new MusicHub({ library: lib, sources, host: host as never, output: () => "host" });
    const r = await hh.play({ query: "brightside", source: "spotify" });
    expect(r.text).toBe("Playing 1 track on this PC, starting with Mr. Brightside by The Killers.");
    expect((await hh.play({ query: "brightside", source: "spotify", mode: "add" })).text).toBe("Added 1 track to the queue on this PC.");
  });

  it("tells why the PC stopped, when it did by itself", () => {
    (host as unknown as { lastError: () => string | null }).lastError = () => "mpv stopped unexpectedly. Play again to start it again.";
    expect(h.nowPlaying().text).toMatch(/mpv stopped unexpectedly/);
  });

  it("goes back to the screen the moment the output is the screen again", async () => {
    output = "screen";
    await h.play({ query: "miles" });
    expect(host.commands).toHaveLength(0);
    expect(screen.commands()).toHaveLength(1);
    expect(h.nowPlaying().text).toMatch(/nothing is playing/i);
  });
});

describe("playing from SoundCloud", () => {
  const scTracks = [{ ref: "soundcloud:1001", source: "soundcloud" as const, title: "Midnight City", artist: "M83 Official", album: "", durationSec: 243 }];
  const sc = (connected = true): MusicSource => ({
    id: "soundcloud" as const,
    status: () => ({ connected, needs: connected ? null : "Connect your SoundCloud account in Plugins, SoundCloud.", account: "me" }),
    search: async () => scTracks,
    playlists: async () => [],
    tracksOf: async () => [],
    track: async () => null,
  });
  const make = (s: MusicSource = sc()) => {
    const sources = new MusicSources([new LocalSource(lib), s], { defaultSource: () => "local", searchLimit: () => 10 });
    const h = new MusicHub({ library: lib, sources });
    const c = new Conn();
    h.attach(c);
    return { h, c };
  };

  it("plays a SoundCloud track by its ref", async () => {
    const { h, c } = make();
    const r = await h.play({ query: "midnight", source: "soundcloud" });
    expect(r.ok).toBe(true);
    expect(c.commands()[0]).toMatchObject({ action: "play", tracks: [{ id: "soundcloud:1001", title: "Midnight City" }] });
  });

  it("names SoundCloud in a search listing, and asks for words when none are given", async () => {
    const { h } = make();
    expect((await h.search({ query: "midnight", source: "soundcloud" })).text).toMatch(/Midnight City — M83 Official.*SoundCloud/);
    expect(await h.play({ source: "soundcloud" })).toEqual({ ok: false, text: expect.stringContaining("play from SoundCloud") });
  });

  it("a SoundCloud that is not connected says what to do, and nothing is sent", async () => {
    const { h, c } = make(sc(false));
    const r = await h.play({ query: "midnight", source: "soundcloud" });
    expect(r).toEqual({ ok: false, text: expect.stringContaining("Connect your SoundCloud account") });
    expect(c.commands()).toHaveLength(0);
  });
});

describe("playing from Audius", () => {
  const tracks = [{ ref: "audius:95wro", source: "audius" as const, title: "Stars In The Sky", artist: "Lofi Army", album: "", durationSec: 71 }];
  const au: MusicSource = { id: "audius" as const, status: () => ({ connected: true, needs: null, account: null }), search: async () => tracks, playlists: async () => [], tracksOf: async () => [], track: async () => null };
  const make = () => {
    const sources = new MusicSources([new LocalSource(lib), au], { defaultSource: () => "local", searchLimit: () => 10 });
    const h = new MusicHub({ library: lib, sources });
    const c = new Conn();
    h.attach(c);
    return { h, c };
  };

  it("plays an Audius track by its ref and names Audius in a listing", async () => {
    const { h, c } = make();
    expect((await h.play({ query: "stars", source: "audius" })).ok).toBe(true);
    expect(c.commands()[0]).toMatchObject({ action: "play", tracks: [{ id: "audius:95wro" }] });
    expect((await h.search({ query: "stars", source: "audius" })).text).toMatch(/Lofi Army.*Audius/);
    expect(await h.play({ source: "audius" })).toEqual({ ok: false, text: expect.stringContaining("play from Audius") });
  });
});
