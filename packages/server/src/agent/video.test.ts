import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import type { VideoResult } from "../video/hub";
import { Agent } from "./loop";
import { buildSystemPrompt } from "./prompt";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const one = (name: string, args: unknown = {}): ProviderEvent[][] => [[call("t1", name, args), done], [text("ok"), done]];

let emitted: ServerMsg[];
let config: Config;
let build: (provider: FakeProvider, video?: unknown) => Agent;
const emit = (m: ServerMsg) => void emitted.push(m);
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls.at(-1)!.messages.at(-1));
const asked = () => emitted.filter((m) => m.type === "approval.request");
const stageCmds = () => emitted.filter((m) => m.type === "stage").map((m) => (m as Extract<ServerMsg, { type: "stage" }>).command);

const SRC = "/api/video/" + "a".repeat(32);
function fakeVideo(over: { play?: VideoResult; control?: VideoResult } = {}) {
  return {
    play: vi.fn(async () => over.play ?? ({ ok: true, text: 'Playing "Lofi Girl" on your Friend screen.', show: { id: "video-now", props: { title: "Lofi Girl", src: SRC } } } as VideoResult)),
    control: vi.fn(async () => over.control ?? ({ ok: true, text: "Stopped the video.", hide: "video-now" } as VideoResult)),
    check: vi.fn(async () => ({ ok: true as const, text: "yt-dlp 2026.10.01 (found)" })),
    nowPlaying: vi.fn(() => "Nothing is playing."),
  };
}

beforeEach(async () => {
  emitted = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-agentvideo-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider, video) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      ...(video ? { video: video as never } : {}),
    });
});

describe("what the assistant is told about videos", () => {
  const owner = () => buildSystemPrompt("Jarvis", "scene=conversation");
  it("knows video.play, video.control and video.check", () => {
    const p = owner();
    for (const t of ["video.play", "video.control", "video.check"]) expect(p, t).toContain(t);
  });
  it("is told to play a video or a song from YouTube inside Friend, and never to open the site in the owner's browser", () => {
    const p = owner();
    expect(p).toMatch(/video, a song or a clip from YouTube or any website, use video\.play/i);
    expect(p).toMatch(/Never open the site in the owner's Chrome or any browser/i);
    expect(p).toMatch(/browser tools/i);
  });
  it("is told which tool is for which music: the folder and the music services use music.play, YouTube uses video.play", () => {
    const p = owner();
    expect(p).toMatch(/music\.play does not play YouTube: use video\.play/);
  });
  it("is told what to do when Web video is off or a helper is missing: say so, never fall back to the browser", () => {
    const p = owner();
    expect(p).toMatch(/Web video is not switched on.*Plugins, Web video/s);
    expect(p).toMatch(/not (?:a )?reason to open (?:it in )?(?:a|the) browser|instead of opening/i);
  });
});

describe("playing a video by asking", () => {
  it("plays it without a card, puts a video card on the screen with a Friend address, and tells the model what is playing", async () => {
    const v = fakeVideo();
    const p = new FakeProvider(one("video.play", { query: "lofi girl" }));
    await build(p, v).runTurn("play lofi girl on youtube", ctx);
    expect(asked()).toEqual([]);
    expect(v.play).toHaveBeenCalledWith({ query: "lofi girl" });
    const show = stageCmds().find((c) => c.cmd === "show") as { object: { id: string; type: string; props: { title: string; src: string } } } | undefined;
    expect(show?.object).toMatchObject({ id: "video-now", type: "video", props: { title: "Lofi Girl", src: SRC } });
    expect(lastTool(p)).toMatch(/Playing \\"Lofi Girl\\" on your Friend screen/);
  });

  it("plays in a window on the PC without putting anything on the screen", async () => {
    const v = fakeVideo({ play: { ok: true, text: 'Playing "X" in a window on this PC.' } });
    const p = new FakeProvider(one("video.play", { url: "https://youtu.be/abc", output: "host" }));
    await build(p, v).runTurn("play it on the pc", ctx);
    expect(v.play).toHaveBeenCalledWith({ url: "https://youtu.be/abc", output: "host" });
    expect(stageCmds().find((c) => c.cmd === "show")).toBeUndefined();
    expect(lastTool(p)).toMatch(/window on this PC/);
  });

  it("passes on what stopped it, in the tool's own words", async () => {
    const v = fakeVideo({ play: { ok: false, text: "ffmpeg is not installed. Install it once with: winget install ffmpeg." } });
    const p = new FakeProvider(one("video.play", { query: "x" }));
    await build(p, v).runTurn("play x", ctx);
    expect(lastTool(p)).toMatch(/winget install ffmpeg/);
    expect(stageCmds().find((c) => c.cmd === "show")).toBeUndefined();
  });

  it("stops by taking the card off the screen", async () => {
    const v = fakeVideo();
    const p = new FakeProvider([[call("t1", "video.play", { query: "lofi" }), done], [call("t2", "video.control", { action: "stop" }), done], [text("ok"), done]]);
    await build(p, v).runTurn("play lofi, then stop it", ctx);
    expect(v.control).toHaveBeenCalledWith({ action: "stop" });
    expect(stageCmds().find((c) => c.cmd === "hide")).toMatchObject({ id: "video-now" });
  });

  it("a jump to a time shows the new card in place of the old one", async () => {
    const v = fakeVideo({ control: { ok: true, text: "Jumped to 120 seconds.", show: { id: "video-now", props: { title: "Lofi Girl", src: SRC } } } });
    const p = new FakeProvider(one("video.control", { action: "seek", seconds: 120 }));
    await build(p, v).runTurn("skip to minute two", ctx);
    expect(stageCmds().find((c) => c.cmd === "show")).toBeDefined();
  });

  it("checks what Friend needs", async () => {
    const v = fakeVideo();
    const p = new FakeProvider(one("video.check", {}));
    await build(p, v).runTurn("why will the video not play", ctx);
    expect(lastTool(p)).toMatch(/yt-dlp 2026\.10\.01/);
  });

  it("says plainly when this Friend has no video support", async () => {
    const p = new FakeProvider(one("video.play", { query: "x" }));
    await build(p).runTurn("play x", ctx);
    expect(lastTool(p)).toMatch(/Web video is not available/);
  });

  it("is not for anyone but the owner: a guest voice or a household member never reaches it", async () => {
    const v = fakeVideo();
    const p = new FakeProvider(one("video.play", { query: "x" }));
    await build(p, v).runTurn("play x", { ...ctx, trust: "member" as never });
    expect(v.play).not.toHaveBeenCalled();
  });
});
