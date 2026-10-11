import type { ClientMsg, MusicCommand } from "@friend/protocol";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "../store";
import { commandToAction, useMusicPlayer, type PlayerAudio } from "./useMusicPlayer";

class FakeAudio implements PlayerAudio {
  src = "";
  currentTime = 0;
  duration = NaN;
  volume = 1;
  muted = false;
  paused = true;
  preload = "";
  private handlers = new Map<string, Set<() => void>>();
  plays = 0;
  rejectNextPlay = false;
  play() {
    this.plays++;
    if (this.rejectNextPlay) {
      this.rejectNextPlay = false;
      return Promise.reject(new Error("blocked"));
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(type: string, fn: () => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.handlers.get(type)?.delete(fn);
  }
  fire(type: string) {
    for (const fn of this.handlers.get(type) ?? []) fn();
  }
}

const track = (n: number) => ({ id: String(n).padStart(16, "0"), title: `Song ${n}`, artist: "Artist", album: "Album", durationSec: 100 });
const music = { folderSet: true, volume: 55, shuffle: false, repeat: "all" as const, visualizer: true, startView: "mini" as const };

let audio: FakeAudio;
let sent: ClientMsg[];
function mount(over: { cmd?: { n: number; command: MusicCommand } | null; connection?: Connection } = {}) {
  return renderHook((p: { cmd: { n: number; command: MusicCommand } | null; connection: Connection }) => useMusicPlayer({ music, cmd: p.cmd, send: (m) => sent.push(m), connection: p.connection, createAudio: () => audio }), {
    initialProps: { cmd: over.cmd ?? null, connection: over.connection ?? ("open" as Connection) },
  });
}
const play = (n: number, tracks = [track(1), track(2), track(3)]) => ({ n, command: { action: "play", tracks, mode: "replace" } as MusicCommand });

beforeEach(() => {
  audio = new FakeAudio();
  sent = [];
  localStorage.clear();
});

describe("what the assistant asks for", () => {
  it("turns each command into a step, and ignores one it cannot use", () => {
    expect(commandToAction({ action: "play", tracks: [track(1)], mode: "next", shuffle: true })).toMatchObject({ type: "play", mode: "next", shuffle: true });
    expect(commandToAction({ action: "volume", delta: -10 })).toEqual({ type: "volume", delta: -10 });
    expect(commandToAction({ action: "seek", percent: 40 })).toEqual({ type: "seek", percent: 40 });
    expect(commandToAction({ action: "repeat", mode: "one" })).toEqual({ type: "repeat", mode: "one" });
    expect(commandToAction({ action: "queue.remove", index: 2 })).toEqual({ type: "remove", index: 2 });
    expect(commandToAction({ action: "queue.clear" })).toEqual({ type: "clear" });
    expect(commandToAction({ action: "repeat" })).toBeNull();
    expect(commandToAction({ action: "view" })).toBeNull();
  });
});

describe("playing", () => {
  it("loads the first track and starts it when told to play", () => {
    const { result } = mount({ cmd: play(1) });
    expect(audio.src).toBe(`/api/music/track/${track(1).id}`);
    expect(audio.plays).toBeGreaterThan(0);
    expect(result.current.state).toMatchObject({ playing: true, index: 0 });
    expect(result.current.current?.title).toBe("Song 1");
  });

  it("takes the owner's settings as its starting point", () => {
    const { result } = mount();
    expect(result.current.state).toMatchObject({ volume: 55, repeat: "all", view: "mini" });
  });

  it("stays closed after a refresh once the owner closed it", () => {
    const first = mount();
    act(() => first.result.current.dispatch({ type: "view", view: "hidden" }));
    first.unmount();
    const again = mount();
    expect(again.result.current.state.view).toBe("hidden");
  });

  it("runs the same command number only once, and a new number again", () => {
    const { rerender } = mount({ cmd: play(1) });
    const first = audio.plays;
    rerender({ cmd: play(1), connection: "open" });
    expect(audio.plays).toBe(first);
    rerender({ cmd: { n: 2, command: { action: "next" } }, connection: "open" });
    expect(audio.src).toBe(`/api/music/track/${track(2).id}`);
  });

  it("moves on when a track ends, and to the next when one cannot be played", () => {
    const { result } = mount({ cmd: play(1) });
    act(() => audio.fire("ended"));
    expect(result.current.state.index).toBe(1);
    act(() => audio.fire("error"));
    expect(result.current.state.index).toBe(2);
  });

  it("follows time updates from the audio", () => {
    const { result } = mount({ cmd: play(1) });
    audio.currentTime = 42;
    audio.duration = 200;
    act(() => audio.fire("loadedmetadata"));
    expect(result.current.state).toMatchObject({ position: 42, duration: 200 });
  });

  it("pauses the audio when told to pause and plays again when told to resume", async () => {
    const { rerender } = mount({ cmd: play(1) });
    await act(async () => {}); // the first play() settles
    rerender({ cmd: { n: 2, command: { action: "pause" } }, connection: "open" });
    expect(audio.paused).toBe(true);
    rerender({ cmd: { n: 3, command: { action: "resume" } }, connection: "open" });
    await act(async () => {});
    expect(audio.paused).toBe(false);
  });

  it("sets the audio's volume and mute, and seeks the audio", () => {
    const { rerender, result } = mount({ cmd: play(1) });
    rerender({ cmd: { n: 2, command: { action: "volume", level: 20 } }, connection: "open" });
    expect(audio.volume).toBeCloseTo(0.2);
    rerender({ cmd: { n: 3, command: { action: "mute", on: true } }, connection: "open" });
    expect(audio.muted).toBe(true);
    audio.duration = 200;
    act(() => audio.fire("loadedmetadata"));
    rerender({ cmd: { n: 4, command: { action: "seek", seconds: 90 } }, connection: "open" });
    expect(audio.currentTime).toBe(90);
    expect(result.current.state.volume).toBe(20);
  });

  it("remembers the volume and choices in this browser", () => {
    const { rerender } = mount({ cmd: play(1) });
    rerender({ cmd: { n: 2, command: { action: "volume", level: 33 } }, connection: "open" });
    rerender({ cmd: { n: 3, command: { action: "repeat", mode: "one" } }, connection: "open" });
    expect(JSON.parse(localStorage.getItem("friend.music")!)).toMatchObject({ volume: 33, repeat: "one" });
  });
});

describe("sound the browser blocks", () => {
  it("says so, and starts when the person touches the page", () => {
    audio.rejectNextPlay = true;
    const { result } = mount({ cmd: play(1) });
    return vi.waitFor(() => expect(result.current.blocked).toBe(true)).then(async () => {
      act(() => void window.dispatchEvent(new Event("pointerdown")));
      await vi.waitFor(() => expect(result.current.blocked).toBe(false));
      expect(audio.paused).toBe(false);
    });
  });
});

describe("telling the server", () => {
  it("reports the player as it is, with the queue, and whether this screen is the one to reach", () => {
    mount({ cmd: play(1) });
    const last = [...sent].reverse().find((m) => m.type === "music.state") as Extract<ClientMsg, { type: "music.state" }>;
    expect(last.state).toMatchObject({ playing: true, trackId: track(1).id, title: "Song 1", artist: "Artist", volume: 55, index: 0, active: false });
    expect(last.state.queue.map((q) => q.title)).toEqual(["Song 1", "Song 2", "Song 3"]);
    act(() => void window.dispatchEvent(new Event("pointerdown")));
  });

  it("says nothing while not connected", () => {
    mount({ cmd: play(1), connection: "connecting" });
    expect(sent.filter((m) => m.type === "music.state")).toHaveLength(0);
  });
});
