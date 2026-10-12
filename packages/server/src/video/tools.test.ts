import { describe, expect, it } from "vitest";
import { findHelper, videoStatus } from "./tools";

type Run = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
const runOf = (known: Record<string, string>): Run => async (cmd, args) => (known[cmd] !== undefined && args[0] === (cmd.includes("ffmpeg") ? "-version" : "--version") ? { code: 0, out: known[cmd]! } : { code: -1, out: "" });

describe("finding yt-dlp", () => {
  it("is the program on the PATH, with its version", async () => {
    const r = await findHelper("yt-dlp", { program: "", platform: "linux", env: {}, exists: () => false, run: runOf({ "yt-dlp": "2026.10.01\n" }) });
    expect(r).toEqual({ found: true, path: "yt-dlp", version: "2026.10.01" });
  });
  it("is the program the owner set, when it is one, and says so when it is not", async () => {
    const run = runOf({ "C:\\tools\\yt-dlp.exe": "2026.09.15", notit: "hello" });
    expect(await findHelper("yt-dlp", { program: "C:\\tools\\yt-dlp.exe", platform: "win32", env: {}, exists: () => true, run })).toEqual({ found: true, path: "C:\\tools\\yt-dlp.exe", version: "2026.09.15" });
    const bad = await findHelper("yt-dlp", { program: "notit", platform: "win32", env: {}, exists: () => true, run });
    expect(bad).toMatchObject({ found: false, install: expect.stringMatching(/set in Settings is not yt-dlp.*winget install yt-dlp/i) });
  });
  it("looks in the usual places for the system when it is not on the PATH", async () => {
    const win = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\yt-dlp.exe";
    const r = await findHelper("yt-dlp", { program: "", platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, exists: (p) => p === win, run: runOf({ [win]: "2026.10.01" }) });
    expect(r).toMatchObject({ found: true, path: win });
    const mac = await findHelper("yt-dlp", { program: "", platform: "darwin", env: {}, exists: (p) => p === "/opt/homebrew/bin/yt-dlp", run: runOf({ "/opt/homebrew/bin/yt-dlp": "2026.10.01" }) });
    expect(mac).toMatchObject({ found: true, path: "/opt/homebrew/bin/yt-dlp" });
  });
  it("is one sentence naming the install command for the system when it is missing", async () => {
    const none = { program: "", env: {}, exists: () => false, run: runOf({}) };
    expect(await findHelper("yt-dlp", { ...none, platform: "win32" })).toEqual({ found: false, install: expect.stringMatching(/winget install yt-dlp/) });
    expect(await findHelper("yt-dlp", { ...none, platform: "darwin" })).toEqual({ found: false, install: expect.stringMatching(/brew install yt-dlp/) });
    expect(await findHelper("yt-dlp", { ...none, platform: "linux" })).toEqual({ found: false, install: expect.stringMatching(/pipx install yt-dlp/) });
  });
  it("does not take a program that answers something else", async () => {
    expect(await findHelper("yt-dlp", { program: "", platform: "linux", env: {}, exists: () => false, run: runOf({ "yt-dlp": "command not found" }) })).toMatchObject({ found: false });
  });
});

describe("finding ffmpeg", () => {
  it("reads the version from the first line", async () => {
    const r = await findHelper("ffmpeg", { program: "", platform: "linux", env: {}, exists: () => false, run: runOf({ ffmpeg: "ffmpeg version 7.1-full_build-www.gyan.dev Copyright (c) 2000-2024\nbuilt with gcc" }) });
    expect(r).toEqual({ found: true, path: "ffmpeg", version: "7.1-full_build-www.gyan.dev" });
  });
  it("says how to install it when missing", async () => {
    expect(await findHelper("ffmpeg", { program: "", platform: "win32", env: {}, exists: () => false, run: runOf({}) })).toEqual({ found: false, install: expect.stringMatching(/winget install ffmpeg/) });
    expect(await findHelper("ffmpeg", { program: "", platform: "linux", env: {}, exists: () => false, run: runOf({}) })).toEqual({ found: false, install: expect.stringMatching(/apt install ffmpeg/) });
  });
});

describe("videoStatus", () => {
  const config = (over: Record<string, string> = {}) => ({ video: { ytdlp: "", ffmpeg: "", ...over }, music: { hostPlayer: "" } }) as never;
  it("is all three programs at once, with what is missing", async () => {
    const s = await videoStatus(config(), { platform: "linux", env: {}, exists: () => false, run: runOf({ "yt-dlp": "2026.10.01", ffmpeg: "ffmpeg version 7.1", mpv: "mpv 0.39.0 Copyright" }) });
    expect(s.ytdlp).toMatchObject({ found: true, version: "2026.10.01" });
    expect(s.ffmpeg).toMatchObject({ found: true, version: "7.1" });
    expect(s.mpv).toMatchObject({ found: true, version: "0.39.0" });
    const part = await videoStatus(config(), { platform: "linux", env: {}, exists: () => false, run: runOf({ "yt-dlp": "2026.10.01" }) });
    expect(part.ytdlp.found).toBe(true);
    expect(part.ffmpeg).toMatchObject({ found: false, install: expect.stringMatching(/ffmpeg/) });
    expect(part.mpv).toMatchObject({ found: false, install: expect.stringMatching(/mpv/) });
  });
  it("uses the programs the owner chose", async () => {
    const s = await videoStatus(config({ ytdlp: "/opt/y/yt-dlp", ffmpeg: "/opt/f/ffmpeg" }), { platform: "linux", env: {}, exists: () => true, run: runOf({ "/opt/y/yt-dlp": "2026.10.01", "/opt/f/ffmpeg": "ffmpeg version 6.0" }) });
    expect(s.ytdlp).toMatchObject({ found: true, version: "2026.10.01" });
    expect(s.ffmpeg).toMatchObject({ found: true, version: "6.0" });
  });
});
