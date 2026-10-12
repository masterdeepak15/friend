import { describe, expect, it } from "vitest";
import { describeCall, TOOL_DEFS as TOOLS } from "./tools";
import { normalizeSites, VIDEO_LIMITS, VIDEO_OUTPUTS } from "./video";

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

describe("the video settings vocabulary", () => {
  it("has the same two outputs as the music player, and sensible limits", () => {
    expect([...VIDEO_OUTPUTS]).toEqual(["screen", "host"]);
    expect(VIDEO_LIMITS.maxHeight).toEqual({ min: 240, max: 1080, def: 720 });
    expect(VIDEO_LIMITS.maxMinutes).toEqual({ min: 1, max: 600, def: 240 });
  });
  it("cleans a list of sites: lower case, a site name only, no repeats, no paths, no more than the limit", () => {
    expect(normalizeSites(["YouTube.com", " vimeo.com ", "youtube.com", "https://dailymotion.com/x", "bad name", "localhost", "a..b", "-x.com", ""])).toEqual(["youtube.com", "vimeo.com", "dailymotion.com"]);
    expect(normalizeSites("youtube.com")).toEqual([]);
    expect(normalizeSites(Array.from({ length: 80 }, (_, i) => `site${i}.com`))).toHaveLength(VIDEO_LIMITS.sites.max);
  });
});

describe("the video tools", () => {
  it("are three, as light as the music tools (no approval), run by the gateway", () => {
    for (const n of ["video.play", "video.control", "video.check"]) expect(tool(n), n).toMatchObject({ baseTier: n === "video.check" ? "T0" : "T1", target: "gateway" });
  });
  it("play takes a link or words, where to show it, and a start time, and nothing else", () => {
    const play = tool("video.play").input;
    expect(play.safeParse({ url: "https://www.youtube.com/watch?v=abc" }).success).toBe(true);
    expect(play.safeParse({ query: "lofi hip hop", output: "host", start: 90 }).success).toBe(true);
    expect(play.safeParse({ query: "x", output: "tv" }).success).toBe(false);
    expect(play.safeParse({ query: "x", start: -1 }).success).toBe(false);
    expect(play.safeParse({ url: "x".repeat(2100) }).success).toBe(false);
    expect(play.safeParse({ query: "x", command: "rm -rf" }).success).toBe(false);
  });
  it("control takes the few actions a person says, with a time or a level where they need one", () => {
    const c = tool("video.control").input;
    for (const action of ["pause", "resume", "stop", "seek", "volume"]) expect(c.safeParse({ action }).success, action).toBe(true);
    expect(c.safeParse({ action: "seek", seconds: 120 }).success).toBe(true);
    expect(c.safeParse({ action: "volume", level: 40 }).success).toBe(true);
    expect(c.safeParse({ action: "volume", level: 140 }).success).toBe(false);
    expect(c.safeParse({ action: "delete" }).success).toBe(false);
  });
  it("say in plain words what the owner would be approving or reading", () => {
    expect(describeCall("video.play", { url: "https://youtu.be/abc" })).toBe("Play the video https://youtu.be/abc");
    expect(describeCall("video.play", { query: "lofi" })).toBe("Find and play a video: lofi");
    expect(describeCall("video.control", { action: "pause" })).toBe("Video: pause");
    expect(describeCall("video.check", {})).toBe("Check what Friend needs to play videos");
  });
});
