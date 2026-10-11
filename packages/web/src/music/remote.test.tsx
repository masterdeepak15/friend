import type { ClientMsg, MusicCommand, MusicState } from "@friend/protocol";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicPlayerView } from "./MusicPlayer";
import { useMusicPlayer, type MusicPlayer, type PlayerAudio } from "./useMusicPlayer";
import { useRemoteMusic } from "./useRemoteMusic";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

class Audio implements PlayerAudio {
  src = "";
  currentTime = 0;
  duration = NaN;
  volume = 1;
  muted = false;
  paused = true;
  preload = "";
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

const music = { folderSet: true, volume: 55, shuffle: false, repeat: "all" as const, visualizer: false, startView: "full" as const };
const host = (over: Partial<MusicState> = {}): MusicState => ({
  playing: true,
  trackId: "0000000000000002",
  title: "Blue in Green",
  artist: "Miles Davis",
  album: "Kind of Blue",
  position: 65,
  duration: 337,
  volume: 40,
  muted: false,
  shuffle: true,
  repeat: "one",
  view: "mini",
  queue: [
    { id: "0000000000000001", title: "So What" },
    { id: "0000000000000002", title: "Blue in Green" },
  ],
  index: 1,
  active: true,
  ...over,
});
const track = (n: number) => ({ id: String(n).padStart(16, "0"), title: `Song ${n}`, artist: "A", album: "B", durationSec: 100 });

describe("the player in remote mode (the PC plays)", () => {
  it("builds no audio element and no Spotify engine, loads nothing and reports nothing", () => {
    const createAudio = vi.fn(() => new Audio());
    const createSpotify = vi.fn(() => new Audio());
    const sent: ClientMsg[] = [];
    const AudioCtor = vi.fn();
    vi.stubGlobal("Audio", AudioCtor);
    renderHook(() => useMusicPlayer({ music: { ...music, output: "host" }, remote: true, cmd: { n: 1, command: { action: "play", tracks: [track(1)], mode: "replace" } }, send: (m) => sent.push(m), connection: "open", createAudio, createSpotify }));
    expect(createAudio).not.toHaveBeenCalled();
    expect(createSpotify).not.toHaveBeenCalled();
    expect(AudioCtor).not.toHaveBeenCalled();
    expect(sent.filter((m) => m.type === "music.state")).toHaveLength(0);
  });

  it("builds the local player when the output goes back to the screen, and plays there", () => {
    const audio = new Audio();
    const createAudio = vi.fn(() => audio);
    const sent: ClientMsg[] = [];
    const { rerender } = renderHook((p: { remote: boolean }) => useMusicPlayer({ music, remote: p.remote, cmd: p.remote ? null : { n: 1, command: { action: "play", tracks: [track(1)], mode: "replace" } }, send: (m) => sent.push(m), connection: "open", createAudio }), { initialProps: { remote: true } });
    expect(createAudio).not.toHaveBeenCalled();
    rerender({ remote: false });
    expect(createAudio).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe("/api/music/track/0000000000000001");
    expect(sent.some((m) => m.type === "music.state")).toBe(true);
  });

  it("switching to the PC pauses the screen's own sound", () => {
    const audio = new Audio();
    const { rerender } = renderHook((p: { remote: boolean }) => useMusicPlayer({ music, remote: p.remote, cmd: { n: 1, command: { action: "play", tracks: [track(1)], mode: "replace" } }, send: () => {}, connection: "open", createAudio: () => audio }), { initialProps: { remote: false } });
    expect(audio.paused).toBe(false);
    rerender({ remote: true });
    expect(audio.paused).toBe(true);
  });
});

describe("going to the PC and back", () => {
  const play1: { n: number; command: MusicCommand } = { n: 1, command: { action: "play", tracks: [track(1)], mode: "replace" } };

  it("the screen's own player stops, so coming back does not start the old track again by itself", () => {
    const audio = new Audio();
    let plays = 0;
    const realPlay = audio.play.bind(audio);
    audio.play = () => {
      plays++;
      return realPlay();
    };
    const { result, rerender } = renderHook((p: { remote: boolean; cmd: typeof play1 | null }) => useMusicPlayer({ music, remote: p.remote, cmd: p.cmd, send: () => {}, connection: "open", createAudio: () => audio }), { initialProps: { remote: false, cmd: play1 as typeof play1 | null } });
    expect(plays).toBe(1);
    rerender({ remote: true, cmd: play1 });
    expect(result.current.state.playing).toBe(false);
    rerender({ remote: false, cmd: play1 });
    expect(plays).toBe(1);
    expect(audio.paused).toBe(true);
  });

  it("gives back the audio context and the Spotify engine each time, so none pile up", () => {
    const closed = vi.fn(async () => {});
    class Ctx {
      destination = {};
      createMediaElementSource() {
        return { connect() {} };
      }
      createAnalyser() {
        return { connect() {}, fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 0, getByteFrequencyData() {} };
      }
      close = closed;
    }
    vi.stubGlobal("AudioContext", Ctx);
    const engine = Object.assign(new Audio(), { error: null as string | null, dispose: vi.fn() });
    const { rerender } = renderHook((p: { remote: boolean }) => useMusicPlayer({ music, remote: p.remote, cmd: { n: 1, command: { action: "play", tracks: [{ ...track(1), id: "spotify:4uLU6hMCjMI75M1A2tKUQC" }, track(2)], mode: "replace" } }, send: () => {}, connection: "open", createAudio: () => new Audio(), createSpotify: () => engine }), { initialProps: { remote: false } });
    rerender({ remote: true });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("useRemoteMusic", () => {
  const stubLocal = (view: "mini" | "full" | "hidden" = "full") => ({ state: { queue: [], index: -1, playing: false, position: 0, duration: 0, volume: 70, muted: false, shuffle: false, repeat: "all", view }, dispatch: vi.fn(), current: null, blocked: true, notice: "x", analyser: {}, unlock: vi.fn(), audio: { current: null }, remote: false }) as unknown as MusicPlayer;

  it("shows what the PC is playing, and keeps its own view (mini, full or hidden)", () => {
    const { result } = renderHook(() => useRemoteMusic({ local: stubLocal("full"), host: host(), send: () => {} }));
    expect(result.current.state).toMatchObject({ playing: true, index: 1, position: 65, duration: 337, volume: 40, shuffle: true, repeat: "one", view: "full" });
    expect(result.current.current).toMatchObject({ id: "0000000000000002", title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue" });
    expect(result.current.remote).toBe(true);
    expect(result.current.blocked).toBe(false);
    expect(result.current.notice).toBeNull();
    expect(result.current.analyser).toBeNull();
  });

  it("is empty until the PC has said anything", () => {
    const { result } = renderHook(() => useRemoteMusic({ local: stubLocal(), host: null, send: () => {} }));
    expect(result.current.state).toMatchObject({ queue: [], index: -1, playing: false });
    expect(result.current.current).toBeNull();
  });

  it("a button sends a command to the PC; the view stays on the screen", () => {
    const sent: ClientMsg[] = [];
    const local = stubLocal();
    const { result } = renderHook(() => useRemoteMusic({ local, host: host(), send: (m) => sent.push(m) }));
    act(() => {
      result.current.dispatch({ type: "next" });
      result.current.dispatch({ type: "volume", level: 20 });
      result.current.dispatch({ type: "play", tracks: [track(5)], mode: "replace", start: 0 });
      result.current.dispatch({ type: "jump", index: 0 });
      result.current.dispatch({ type: "time", position: 3, duration: 100 });
      result.current.dispatch({ type: "view", view: "hidden" });
    });
    expect(sent).toEqual([
      { type: "music.remote", command: { action: "next" } },
      { type: "music.remote", command: { action: "volume", level: 20 } },
      { type: "music.remote", command: { action: "play", tracks: [track(5)], mode: "replace", index: 0 } },
      { type: "music.remote", command: { action: "jump", index: 0 } },
    ]);
    expect(local.dispatch).toHaveBeenCalledWith({ type: "view", view: "hidden" });
  });
});

describe("the player's face in remote mode", () => {
  it("says it is playing on this PC", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sources: [], tracks: [], total: 0 }))));
    const { result } = renderHook(() => useRemoteMusic({ local: { state: { queue: [], index: -1, playing: false, position: 0, duration: 0, volume: 70, muted: false, shuffle: false, repeat: "all", view: "full" }, dispatch: vi.fn(), current: null, blocked: false, notice: null, analyser: null, unlock: vi.fn(), audio: { current: null }, remote: false } as unknown as MusicPlayer, host: host(), send: () => {} }));
    render(<MusicPlayerView player={result.current} music={{ ...music, output: "host" }} animations="off" />);
    expect((await screen.findAllByText("THIS PC")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Blue in Green").length).toBeGreaterThan(0);
  });
});
