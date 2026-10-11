import { describe, expect, it } from "vitest";
import { MusicTrackRef } from "./messages";
import { DEFAULT_SOURCES } from "./hud";
import { makeRef, MUSIC_SOURCES, parseRef } from "./musicRef";
import { TOOL_DEFS as TOOLS } from "./tools";

describe("music track refs", () => {
  it("reads a bare id as a local track", () => {
    expect(parseRef("0123456789abcdef")).toEqual({ source: "local", id: "0123456789abcdef" });
  });
  it("reads a source-prefixed ref", () => {
    expect(parseRef("spotify:4uLU6hMCjMI75M1A2tKUQC")).toEqual({ source: "spotify", id: "4uLU6hMCjMI75M1A2tKUQC" });
    expect(parseRef("local:0123456789abcdef")).toEqual({ source: "local", id: "0123456789abcdef" });
  });
  it("refuses anything else", () => {
    for (const bad of ["spotify:../x", "youtube:abc", "", "spotify:", "spotify:a b", "ABCDEF"]) expect(parseRef(bad)).toBeNull();
  });
  it("makes a ref", () => {
    expect(makeRef("local", "0123456789abcdef")).toBe("local:0123456789abcdef");
    expect(MUSIC_SOURCES).toEqual(["local", "spotify", "soundcloud"]);
  });
  it("lets a track carry either form and rejects a bad one", () => {
    const t = { title: "a", artist: "b", album: "c", durationSec: null };
    expect(MusicTrackRef.safeParse({ ...t, id: "0123456789abcdef" }).success).toBe(true);
    expect(MusicTrackRef.safeParse({ ...t, id: "spotify:4uLU6hMCjMI75M1A2tKUQC" }).success).toBe(true);
    expect(MusicTrackRef.safeParse({ ...t, id: "spotify:" }).success).toBe(false);
  });
  it("gives the search, play and queue tools a source", () => {
    for (const name of ["music.play", "music.queue", "music.search"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(tool.input.safeParse({ ...(name === "music.queue" ? { action: "add" } : name === "music.search" ? { query: "x" } : {}), source: "spotify" }).success).toBe(true);
      expect(tool.input.safeParse({ ...(name === "music.queue" ? { action: "add" } : name === "music.search" ? { query: "x" } : {}), source: "youtube" }).success).toBe(false);
    }
  });
  it("knows SoundCloud refs, which are numbers", () => {
    expect(parseRef("soundcloud:123456")).toEqual({ source: "soundcloud", id: "123456" });
    for (const bad of ["soundcloud:abc", "soundcloud:", "soundcloud:" + "1".repeat(21)]) expect(parseRef(bad)).toBeNull();
    expect(makeRef("soundcloud", "9")).toBe("soundcloud:9");
  });
  it("lets SoundCloud be the default source and a tool source", () => {
    expect(DEFAULT_SOURCES).toContain("soundcloud");
    const tool = TOOLS.find((x) => x.name === "music.search")!;
    expect(tool.input.safeParse({ query: "x", source: "soundcloud" }).success).toBe(true);
  });
});
