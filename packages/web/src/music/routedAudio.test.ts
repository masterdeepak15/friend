import { describe, expect, it, vi } from "vitest";
import type { PlayerAudio } from "./useMusicPlayer";
import { RoutedAudio } from "./routedAudio";

class Fake implements PlayerAudio {
  src = "";
  currentTime = 0;
  duration = 0;
  volume = 1;
  muted = false;
  paused = true;
  preload = "";
  plays = 0;
  pauses = 0;
  listeners: Record<string, (() => void)[]> = {};
  play() {
    this.plays++;
    this.paused = false;
  }
  pause() {
    this.pauses++;
    this.paused = true;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  emit(type: string) {
    for (const f of this.listeners[type] ?? []) f();
  }
}

const make = () => {
  const local = new Fake();
  const spot = new Fake();
  const makeSpotify = vi.fn(() => spot);
  return { local, spot, makeSpotify, r: new RoutedAudio(local, makeSpotify) };
};

describe("RoutedAudio", () => {
  it("sends a file from the folder to the audio element and never builds the Spotify engine", () => {
    const { r, local, makeSpotify } = make();
    r.src = "/api/music/track/0123456789abcdef";
    r.play();
    expect(local.src).toBe("/api/music/track/0123456789abcdef");
    expect(local.plays).toBe(1);
    expect(r.src).toBe("/api/music/track/0123456789abcdef");
    expect(makeSpotify).not.toHaveBeenCalled();
  });

  it("sends a spotify: ref to the Spotify engine, built only when first needed, and stops the element", () => {
    const { r, local, spot, makeSpotify } = make();
    r.src = "/api/music/track/0123456789abcdef";
    local.paused = false;
    r.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    expect(makeSpotify).toHaveBeenCalledTimes(1);
    expect(local.pauses).toBe(1);
    expect(spot.src).toBe("spotify:4uLU6hMCjMI75M1A2tKUQC");
    r.play();
    r.pause();
    expect(spot.plays).toBe(1);
    expect(spot.pauses).toBe(1);
    r.src = "spotify:7qiZfU4dY1lWllzX7mPBI3";
    expect(makeSpotify).toHaveBeenCalledTimes(1);
  });

  it("reads position, length and pause state from whichever is active, and seeks it", () => {
    const { r, local, spot } = make();
    local.currentTime = 5;
    local.duration = 100;
    r.src = "/api/music/track/0123456789abcdef";
    expect([r.currentTime, r.duration]).toEqual([5, 100]);
    spot.currentTime = 42;
    spot.duration = 200;
    r.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    expect([r.currentTime, r.duration]).toEqual([42, 200]);
    r.currentTime = 60;
    expect(spot.currentTime).toBe(60);
    expect(local.currentTime).toBe(5);
  });

  it("keeps the volume and mute for both, so a change of track keeps them", () => {
    const { r, local, spot } = make();
    r.volume = 0.3;
    r.muted = true;
    r.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    expect([spot.volume, spot.muted]).toEqual([0.3, true]);
    r.volume = 0.8;
    expect([local.volume, spot.volume]).toEqual([0.8, 0.8]);
  });

  it("passes events only from the engine that is playing, and removes them from both", () => {
    const { r, local, spot } = make();
    const fn = vi.fn();
    r.addEventListener("ended", fn);
    local.emit("ended");
    expect(fn).toHaveBeenCalledTimes(1);
    spot.emit("ended"); // not built yet: nothing to hear
    r.src = "spotify:4uLU6hMCjMI75M1A2tKUQC"; // the engine is built after the listener was added
    local.emit("ended"); // the folder element is not the one playing now
    expect(fn).toHaveBeenCalledTimes(1);
    spot.emit("ended");
    expect(fn).toHaveBeenCalledTimes(2);
    r.src = "/api/music/track/0123456789abcdef";
    spot.emit("error"); // a late error from Spotify must not skip a folder track
    spot.emit("ended");
    expect(fn).toHaveBeenCalledTimes(2);
    local.emit("ended");
    expect(fn).toHaveBeenCalledTimes(3);
    r.removeEventListener("ended", fn);
    local.emit("ended");
    spot.emit("ended");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("clearing the source stops whichever is playing", () => {
    const { r, spot } = make();
    r.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    r.src = "";
    expect(spot.pauses).toBe(1);
    expect(r.src).toBe("");
  });

  it("exposes the real element for the level analyser", () => {
    const { r, local } = make();
    expect(r.element).toBe(local);
  });
});
