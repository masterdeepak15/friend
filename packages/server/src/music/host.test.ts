import { MusicState, type MusicCommand } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPlayer } from "./host";
import type { MpvEvent } from "./mpv";

class FakeMpv {
  calls: unknown[][] = [];
  listeners = new Set<(e: MpvEvent) => void>();
  loadError: string | null = null;
  disposed = 0;
  onEvent(fn: (e: MpvEvent) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  fire(e: MpvEvent) {
    for (const f of this.listeners) f(e);
  }
  async start() {
    return { ok: true as const };
  }
  async load(p: string) {
    if (this.loadError) throw new Error(this.loadError);
    this.calls.push(["load", p]);
  }
  async pause(on: boolean) {
    this.calls.push(["pause", on]);
  }
  async seek(s: number) {
    this.calls.push(["seek", s]);
  }
  async volume(v: number) {
    this.calls.push(["volume", v]);
  }
  async mute(on: boolean) {
    this.calls.push(["mute", on]);
  }
  async stop() {
    this.calls.push(["stop"]);
  }
  dispose() {
    this.disposed++;
  }
  loads = () => this.calls.filter((c) => c[0] === "load").map((c) => c[1]);
}

class FakeSpotify {
  plays: { device: string; ids: string[] }[] = [];
  controls: unknown[] = [];
  playOnResult: { ok: true; deviceId: string } | { ok: false; error: string } = { ok: true, deviceId: "D1" };
  state: { playing: boolean; trackId: string | null; positionMs: number; durationMs: number; deviceName: string } | null = null;
  async playOn(device: string, ids: string[]) {
    this.plays.push({ device, ids });
    return this.playOnResult;
  }
  async control(id: string, c: unknown) {
    this.controls.push([id, c]);
  }
  async playbackState() {
    return this.state;
  }
  status() {
    return { connected: true, needs: null, account: "me" };
  }
}

const folder = (n: number) => ({ id: String(n).padStart(16, "0"), title: `Song ${n}`, artist: "A", album: "B", durationSec: 100 });
const spot = (id: string) => ({ id: `spotify:${id}`, title: `Spotify ${id}`, artist: "A", album: "B", durationSec: 200 });
const play = (tracks: ReturnType<typeof folder>[], extra: Partial<MusicCommand> = {}): MusicCommand => ({ action: "play", tracks, mode: "replace", ...extra });

let mpv: FakeMpv;
let sp: FakeSpotify;
let player: HostPlayer;
let emitted: MusicState[];
let paths: Record<string, string | null>;
let settings: { volume: number; shuffle: boolean; repeat: "off" | "all" | "one"; spotifyDevice: string; hostPlayer: string };

beforeEach(() => {
  mpv = new FakeMpv();
  sp = new FakeSpotify();
  emitted = [];
  paths = { "0000000000000001": "/m/one.mp3", "0000000000000002": "/m/two.mp3", "0000000000000003": "/m/three.mp3" };
  settings = { volume: 60, shuffle: false, repeat: "all", spotifyDevice: "Living room", hostPlayer: "" };
  player = new HostPlayer({ library: { ready: async () => {}, resolve: async (id: string) => paths[id] ?? null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: (s) => void emitted.push(s) });
});
afterEach(() => {
  player.dispose();
  vi.useRealTimers();
});

describe("playing the folder's music", () => {
  it("loads the first track through the library's checked path, at the owner's volume", async () => {
    const r = await player.command(play([folder(1), folder(2)]));
    expect(r.ok).toBe(true);
    expect(mpv.loads()).toEqual(["/m/one.mp3"]);
    expect(mpv.calls).toContainEqual(["volume", 60]);
    expect(player.state()).toMatchObject({ playing: true, trackId: "0000000000000001", title: "Song 1", index: 0, volume: 60 });
  });

  it("never gives mpv a path the library refused, and says so", async () => {
    paths["0000000000000001"] = null;
    const r = await player.command(play([folder(1), folder(2)]));
    expect(mpv.loads()).toEqual(["/m/two.mp3"]);
    expect(r.ok).toBe(true);
    expect(player.state().index).toBe(1);
  });

  it("stops with a reason after several tracks in a row cannot be opened", async () => {
    paths = {};
    const r = await player.command(play([1, 2, 3, 4, 5, 6, 7].map(folder)));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/could not be played/i);
    expect(mpv.loads()).toEqual([]);
    expect(player.state().playing).toBe(false);
  });

  it("an mpv that is not installed stops playback with mpv's own sentence and does not skip through the queue", async () => {
    mpv.loadError = "mpv is not installed. Install it once with: winget install mpv, then try again.";
    const r = await player.command(play([folder(1), folder(2)]));
    expect(r).toEqual({ ok: false, text: expect.stringContaining("winget install mpv") });
    expect(player.state()).toMatchObject({ playing: false, index: 0 });
  });

  it("next, previous, jump and the end of a track move through the queue", async () => {
    await player.command(play([folder(1), folder(2), folder(3)]));
    await player.command({ action: "next" });
    expect(mpv.loads().at(-1)).toBe("/m/two.mp3");
    mpv.fire({ type: "ended" });
    await vi.waitFor(() => expect(mpv.loads().at(-1)).toBe("/m/three.mp3"));
    mpv.fire({ type: "ended" }); // repeat all: back to the start
    await vi.waitFor(() => expect(mpv.loads().at(-1)).toBe("/m/one.mp3"));
    await player.command({ action: "previous" });
    await vi.waitFor(() => expect(mpv.loads().at(-1)).toBe("/m/three.mp3"));
  });

  it("repeat one plays the same track again", async () => {
    settings.repeat = "one";
    player.dispose();
    player = new HostPlayer({ library: { ready: async () => {}, resolve: async (id: string) => paths[id] ?? null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: () => {} });
    await player.command(play([folder(1)]));
    mpv.fire({ type: "ended" });
    await vi.waitFor(() => expect(mpv.loads()).toEqual(["/m/one.mp3", "/m/one.mp3"]));
  });

  it("a file mpv cannot open is skipped once, and the next one plays", async () => {
    await player.command(play([folder(1), folder(2)]));
    mpv.fire({ type: "failed", reason: "mpv could not open or play that file." });
    await vi.waitFor(() => expect(mpv.loads().at(-1)).toBe("/m/two.mp3"));
  });

  it("pause, resume, seek, volume and mute go to mpv, and the queue editing works", async () => {
    await player.command(play([folder(1), folder(2), folder(3)]));
    await player.command({ action: "pause" });
    expect(mpv.calls).toContainEqual(["pause", true]);
    await player.command({ action: "resume" });
    expect(mpv.calls.at(-1)).toEqual(["pause", false]);
    mpv.fire({ type: "time", position: 10, duration: 100 });
    await player.command({ action: "seek", percent: 50 });
    expect(mpv.calls).toContainEqual(["seek", 50]);
    await player.command({ action: "volume", level: 30 });
    expect(mpv.calls).toContainEqual(["volume", 30]);
    await player.command({ action: "mute", on: true });
    expect(mpv.calls).toContainEqual(["mute", true]);
    await player.command({ action: "queue.remove", index: 2 });
    expect(player.state().queue).toHaveLength(2);
    await player.command({ action: "queue.clear" });
    expect(player.state()).toMatchObject({ queue: [], index: -1, playing: false });
    expect(mpv.calls.at(-1)).toEqual(["stop"]);
  });

  it("stop ends playback, and resume then starts the track again", async () => {
    await player.command(play([folder(1)]));
    await player.command({ action: "stop" });
    expect(mpv.calls.at(-1)).toEqual(["stop"]);
    await player.command({ action: "resume" });
    expect(mpv.loads()).toEqual(["/m/one.mp3", "/m/one.mp3"]);
  });

  it("mpv exiting stops playback with a reason, and playing again starts it again", async () => {
    await player.command(play([folder(1)]));
    mpv.fire({ type: "exited" });
    await vi.waitFor(() => expect(player.state().playing).toBe(false));
    expect(player.lastError()).toMatch(/mpv stopped/i);
    await player.command({ action: "resume" });
    expect(mpv.loads()).toHaveLength(2);
  });
});

describe("playing from Spotify", () => {
  it("plays a spotify: track on the named device", async () => {
    const r = await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    expect(r.ok).toBe(true);
    expect(sp.plays).toEqual([{ device: "Living room", ids: ["4uLU6hMCjMI75M1A2tKUQC"] }]);
    expect(mpv.loads()).toEqual([]);
  });

  it("with no device named it says to name one, and plays nothing", async () => {
    settings.spotifyDevice = "";
    const r = await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    expect(r).toEqual({ ok: false, text: expect.stringContaining("Name the Spotify device") });
    expect(sp.plays).toHaveLength(0);
    expect(player.state().playing).toBe(false);
  });

  it("a Spotify error stops playback with its sentence and does not skip through the queue", async () => {
    sp.playOnResult = { ok: false, error: 'No Spotify device named "Living room" is available. Found: Kitchen.' };
    const r = await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never, spot("7qiZfU4dY1lWllzX7mPBI3") as never]));
    expect(r).toEqual({ ok: false, text: expect.stringContaining("Found: Kitchen") });
    expect(sp.plays).toHaveLength(1);
    expect(player.state()).toMatchObject({ playing: false, index: 0 });
  });

  it("controls the device with the id it played on", async () => {
    await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    await player.command({ action: "pause" });
    await player.command({ action: "resume" });
    await player.command({ action: "seek", seconds: 30 });
    await player.command({ action: "volume", level: 40 });
    expect(sp.controls).toEqual(expect.arrayContaining([["D1", { action: "pause" }], ["D1", { action: "resume" }], ["D1", { action: "seek", ms: 30000 }], ["D1", { action: "volume", percent: 40 }]]));
  });

  it("a queue of both kinds switches engines and stops the one that is leaving", async () => {
    await player.command(play([folder(1), spot("4uLU6hMCjMI75M1A2tKUQC") as never, folder(2)]));
    await player.command({ action: "next" });
    expect(mpv.calls).toContainEqual(["stop"]);
    expect(sp.plays).toHaveLength(1);
    await player.command({ action: "next" });
    expect(sp.controls).toContainEqual(["D1", { action: "pause" }]);
    expect(mpv.loads()).toEqual(["/m/one.mp3", "/m/two.mp3"]);
  });

  describe("watching Spotify", () => {
    beforeEach(() => vi.useFakeTimers());

    it("reads the position every two seconds only while a Spotify track plays, and stops when it does not", async () => {
      const reads = vi.spyOn(sp, "playbackState");
      await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
      sp.state = { playing: true, trackId: "4uLU6hMCjMI75M1A2tKUQC", positionMs: 5000, durationMs: 200_000, deviceName: "Living room" };
      await vi.advanceTimersByTimeAsync(2100);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(player.state()).toMatchObject({ position: 5, duration: 200 });
      await vi.advanceTimersByTimeAsync(4100);
      expect(reads).toHaveBeenCalledTimes(3);
      await player.command({ action: "pause" });
      reads.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).not.toHaveBeenCalled();
    });

    it("never reads at all for the folder's music", async () => {
      const reads = vi.spyOn(sp, "playbackState");
      await player.command(play([folder(1)]));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads).not.toHaveBeenCalled();
    });

    it("moves on when Spotify says the track is over", async () => {
      await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never, folder(2)]));
      sp.state = { playing: true, trackId: "4uLU6hMCjMI75M1A2tKUQC", positionMs: 199_000, durationMs: 200_000, deviceName: "Living room" };
      await vi.advanceTimersByTimeAsync(2100);
      sp.state = { playing: false, trackId: "4uLU6hMCjMI75M1A2tKUQC", positionMs: 0, durationMs: 200_000, deviceName: "Living room" };
      await vi.advanceTimersByTimeAsync(2100);
      expect(mpv.loads()).toEqual(["/m/two.mp3"]);
    });

    it("a failed read is one sentence and playback keeps its place; no storm of calls", async () => {
      const reads = vi.spyOn(sp, "playbackState").mockRejectedValue(new Error("Spotify is asking Friend to slow down."));
      await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(2100);
      expect(player.lastError()).toMatch(/slow down/);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(3);
      expect(player.state().index).toBe(0);
    });
  });
});

describe("what it reports and how it ends", () => {
  it("reports a state the server accepts, for folder and Spotify tracks, and at once on a change", async () => {
    await player.command(play([folder(1), spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    expect(emitted.length).toBeGreaterThan(0);
    for (const s of emitted) expect(MusicState.safeParse(s).success).toBe(true);
    await player.command({ action: "next" });
    expect(MusicState.safeParse(emitted.at(-1)).success).toBe(true);
    expect(emitted.at(-1)).toMatchObject({ trackId: "spotify:4uLU6hMCjMI75M1A2tKUQC", active: true });
  });

  it("reports the time at most once a second", async () => {
    vi.useFakeTimers();
    await player.command(play([folder(1)]));
    emitted.length = 0;
    for (let i = 0; i < 20; i++) mpv.fire({ type: "time", position: i, duration: 100 });
    expect(emitted.length).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(1100);
    mpv.fire({ type: "time", position: 30, duration: 100 });
    expect(emitted.length).toBeLessThanOrEqual(2);
  });

  it("is not available with a program setting that cannot be right", () => {
    expect(player.available()).toEqual({ ok: true });
    settings.hostPlayer = "mpv --x";
    expect(player.available()).toEqual({ ok: false, reason: expect.stringMatching(/program/i) });
  });

  it("dispose ends mpv and leaves no timers", async () => {
    vi.useFakeTimers();
    await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    player.dispose();
    expect(mpv.disposed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("hung and failing reads, and being stopped", () => {
  beforeEach(() => vi.useFakeTimers());

  it("a read that never comes back is not asked again behind itself", async () => {
    const reads = vi.spyOn(sp, "playbackState").mockImplementation(() => new Promise(() => {}));
    await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("three failed reads in a row end playback with the sentence, and the screens are told", async () => {
    const told: string[] = [];
    player.dispose();
    player = new HostPlayer({ library: { ready: async () => {}, resolve: async (id: string) => paths[id] ?? null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: () => {}, onError: (t) => void told.push(t) });
    vi.spyOn(sp, "playbackState").mockRejectedValue(new Error("Spotify is asking Friend to slow down."));
    await player.command(play([spot("4uLU6hMCjMI75M1A2tKUQC") as never]));
    await vi.advanceTimersByTimeAsync(7000);
    expect(player.state().playing).toBe(false);
    expect(player.lastError()).toMatch(/slow down/);
    expect(told).toEqual([expect.stringMatching(/slow down/)]);
  });

  it("an mpv that dies on its own, and a run of files that will not play, are told to the screens", async () => {
    const told: string[] = [];
    player.dispose();
    mpv = new FakeMpv();
    player = new HostPlayer({ library: { ready: async () => {}, resolve: async (id: string) => paths[id] ?? null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: () => {}, onError: (t) => void told.push(t) });
    await player.command(play([folder(1)]));
    mpv.fire({ type: "exited" });
    await vi.advanceTimersByTimeAsync(10);
    expect(told).toEqual([expect.stringMatching(/mpv stopped/i)]);
  });

  it("a command that fails is answered to whoever sent it, not also broadcast", async () => {
    const told: string[] = [];
    player.dispose();
    mpv = new FakeMpv();
    mpv.loadError = "mpv is not installed.";
    player = new HostPlayer({ library: { ready: async () => {}, resolve: async (id: string) => paths[id] ?? null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: () => {}, onError: (t) => void told.push(t) });
    const r = await player.command(play([folder(1)]));
    expect(r.ok).toBe(false);
    expect(told).toEqual([]);
  });

  it("being stopped while a track is still loading starts nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    player.dispose();
    mpv = new FakeMpv();
    player = new HostPlayer({ library: { ready: () => gate, resolve: async (id: string) => paths[id] ?? null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: () => {} });
    const p = player.command(play([folder(1)]));
    await vi.advanceTimersByTimeAsync(0); // the load is under way, waiting for the library
    player.dispose();
    release();
    await p;
    expect(mpv.loads()).toEqual([]);
  });
});

describe("playing SoundCloud through mpv", () => {
  const sc = (n: number) => ({ id: `soundcloud:${n}`, title: `SC ${n}`, artist: "A", album: "", durationSec: 100 });
  let streams: Record<string, { ok: true; url: string } | { ok: false; error: string }>;
  let asked: string[];
  beforeEach(() => {
    streams = { "1001": { ok: true, url: "https://cf-media.sndcdn.com/a.mp3?sig=1" }, "1002": { ok: true, url: "https://cf-media.sndcdn.com/b.mp3?sig=2" } };
    asked = [];
    player.dispose();
    player = new HostPlayer({
      library: { ready: async () => {}, resolve: async (id: string) => paths[id] ?? null },
      mpv: mpv as never,
      spotify: sp as never,
      soundcloud: { streamOf: async (id: string) => (asked.push(id), streams[id] ?? { ok: false as const, error: "SoundCloud does not let this account play that track." }) },
      settings: () => settings,
      emit: (s) => void emitted.push(s),
    });
  });

  it("gives mpv the address SoundCloud gave just now, and no device is asked for", async () => {
    const r = await player.command(play([sc(1001) as never]));
    expect(r.ok).toBe(true);
    expect(mpv.loads()).toEqual(["https://cf-media.sndcdn.com/a.mp3?sig=1"]);
    expect(sp.plays).toHaveLength(0);
    expect(player.state()).toMatchObject({ playing: true, trackId: "soundcloud:1001" });
  });

  it("skips a track SoundCloud will not stream, and plays the next", async () => {
    const r = await player.command(play([sc(1003) as never, sc(1001) as never]));
    expect(r.ok).toBe(true);
    expect(mpv.loads()).toEqual(["https://cf-media.sndcdn.com/a.mp3?sig=1"]);
    expect(player.state().index).toBe(1);
  });

  it("a track mpv cannot open is fetched again once (the address may have run out), then skipped", async () => {
    await player.command(play([sc(1001) as never, sc(1002) as never]));
    streams["1001"] = { ok: true, url: "https://cf-media.sndcdn.com/a2.mp3?sig=NEW" };
    mpv.fire({ type: "failed", reason: "mpv could not open or play that file." });
    await vi.waitFor(() => expect(mpv.loads()).toContain("https://cf-media.sndcdn.com/a2.mp3?sig=NEW"));
    expect(player.state().trackId).toBe("soundcloud:1001");
    mpv.fire({ type: "failed", reason: "mpv could not open or play that file." });
    await vi.waitFor(() => expect(player.state().trackId).toBe("soundcloud:1002"));
    expect(asked.filter((x) => x === "1001")).toHaveLength(2);
  });

  it("says so when SoundCloud is not available on the PC", async () => {
    player.dispose();
    player = new HostPlayer({ library: { ready: async () => {}, resolve: async () => null }, mpv: mpv as never, spotify: sp as never, settings: () => settings, emit: () => {} });
    const r = await player.command(play([sc(1001) as never]));
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/SoundCloud/);
    expect(mpv.loads()).toHaveLength(0);
  });
});

describe("SoundCloud on the PC when SoundCloud itself is the problem", () => {
  const sc = (n: number) => ({ id: `soundcloud:${n}`, title: `SC ${n}`, artist: "A", album: "", durationSec: 100 });
  let streams: Record<string, { ok: true; url: string } | { ok: false; error: string }>;
  beforeEach(() => {
    streams = { "1001": { ok: true, url: "https://cf-media.sndcdn.com/a.mp3" }, "1002": { ok: true, url: "https://cf-media.sndcdn.com/b.mp3" } };
    player.dispose();
    player = new HostPlayer({
      library: { ready: async () => {}, resolve: async () => null },
      mpv: mpv as never,
      spotify: sp as never,
      soundcloud: { streamOf: async (id: string) => streams[id] ?? { ok: false as const, error: "SoundCloud does not let this account play that track." } },
      settings: () => settings,
      emit: (s) => void emitted.push(s),
    });
  });

  it("a failed fetch again does not carry the old position into the next track, nor count one failure twice", async () => {
    await player.command(play([sc(1001) as never, sc(1002) as never]));
    mpv.fire({ type: "time", position: 130, duration: 200 });
    streams["1001"] = { ok: false, error: "SoundCloud could not renew the sign-in just now. Try again in a minute." };
    mpv.fire({ type: "failed", reason: "mpv could not open or play that file." });
    await vi.waitFor(() => expect(player.state().trackId).toBe("soundcloud:1002"));
    expect(mpv.calls.filter((c) => c[0] === "seek")).toHaveLength(0);
    expect(mpv.loads()).toEqual(["https://cf-media.sndcdn.com/a.mp3", "https://cf-media.sndcdn.com/b.mp3"]);
  });

  it("a login or connection problem stops playback with SoundCloud's own sentence", async () => {
    streams["1001"] = { ok: false, error: "Reconnect SoundCloud in Plugins, SoundCloud." };
    const r = await player.command(play([sc(1001) as never]));
    expect(r.ok).toBe(false);
    expect(r.text).toContain("Reconnect SoundCloud");
  });
});
