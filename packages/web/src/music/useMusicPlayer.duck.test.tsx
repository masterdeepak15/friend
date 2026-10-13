import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageDuck } from "../audio/duck";
import { useMusicPlayer, type PlayerAudio } from "./useMusicPlayer";

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

const music = { folderSet: true, volume: 70, shuffle: false, repeat: "all" as const, visualizer: false, startView: "full" as const };
const play = { n: 1, command: { action: "play" as const, tracks: [{ id: "0000000000000001", title: "Song", artist: "A", album: "", durationSec: 100 }], mode: "replace" as const } };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  pageDuck.set(1, 0);
});
afterEach(() => {
  pageDuck.set(1, 0);
  vi.useRealTimers();
});

function setup() {
  const audio = new Audio();
  const hook = renderHook(() => useMusicPlayer({ music, cmd: play, send: () => {}, connection: "open", createAudio: () => audio, createSpotify: () => new Audio() }));
  return { audio, hook };
}

describe("music on the screen while someone talks", () => {
  it("turns down to the level, and comes back to the owner's own volume", () => {
    const { audio } = setup();
    expect(audio.volume).toBeCloseTo(0.7);
    act(() => pageDuck.set(0.5, 0));
    expect(audio.volume).toBeCloseTo(0.35);
    act(() => pageDuck.set(1, 0));
    expect(audio.volume).toBeCloseTo(0.7);
  });

  it("slides down and up", () => {
    const { audio } = setup();
    act(() => pageDuck.set(0.25));
    act(() => void vi.advanceTimersByTime(100));
    expect(audio.volume).toBeLessThan(0.7);
    expect(audio.volume).toBeGreaterThan(0.175);
    act(() => void vi.advanceTimersByTime(400));
    expect(audio.volume).toBeCloseTo(0.175);
  });

  it("takes the owner's volume change on top of the lowered level", () => {
    const { audio, hook } = setup();
    act(() => pageDuck.set(0.5, 0));
    act(() => hook.result.current.dispatch({ type: "volume", level: 80 }));
    expect(audio.volume).toBeCloseTo(0.4);
    act(() => pageDuck.set(1, 0));
    expect(audio.volume).toBeCloseTo(0.8);
  });

  it("does not change the volume the owner chose (what the page remembers)", () => {
    const { hook } = setup();
    act(() => pageDuck.set(0.5, 0));
    expect(hook.result.current.state.volume).toBe(70);
  });

  it("stops following when the player goes away", () => {
    const { audio, hook } = setup();
    hook.unmount();
    audio.volume = 0.9;
    act(() => pageDuck.set(0.2, 0));
    expect(audio.volume).toBe(0.9);
  });
});
