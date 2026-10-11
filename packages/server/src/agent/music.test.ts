import type { ServerMsg } from "@friend/protocol";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { MusicHub } from "../music/hub";
import { MusicLibrary } from "../music/library";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const one = (name: string, args: unknown = {}): ProviderEvent[][] => [[call("t1", name, args), done], [text("ok"), done]];

let emitted: ServerMsg[];
let config: Config;
let hub: MusicHub;
let screen: { sent: ServerMsg[]; send: (m: ServerMsg) => void };
let build: (provider: FakeProvider, withMusic?: boolean) => Agent;
const emit = (m: ServerMsg) => void emitted.push(m);
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls.at(-1)!.messages.at(-1));
const asked = () => emitted.filter((m) => m.type === "approval.request");
const commands = () => screen.sent.filter((m) => m.type === "music.command") as Extract<ServerMsg, { type: "music.command" }>[];

beforeEach(async () => {
  emitted = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-agentmusic-"));
  const folder = mkdtempSync(join(tmpdir(), "friend-agentmusic-lib-"));
  mkdirSync(folder, { recursive: true });
  for (const n of ["Miles Davis - So What.mp3", "Miles Davis - Blue in Green.mp3", "Daft Punk - Around the World.mp3"]) writeFileSync(join(folder, n), "x");
  const lib = new MusicLibrary({ folder: () => folder, extensions: () => ["mp3"], maxTracks: () => 100, scanDepth: () => 2 });
  await lib.scan();
  hub = new MusicHub({ library: lib });
  screen = { sent: [], send(m) { this.sent.push(m); } };
  hub.attach(screen);
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider, withMusic = true) =>
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
      ...(withMusic ? { music: hub } : {}),
    });
});

describe("playing music by asking", () => {
  it("plays what was asked for without a card, and tells the model what is playing", async () => {
    const p = new FakeProvider(one("music.play", { query: "miles davis" }));
    await build(p).runTurn("play some Miles Davis", ctx);
    expect(asked()).toEqual([]);
    expect(commands()[0]).toMatchObject({ action: "play", mode: "replace" });
    expect(commands()[0]!.tracks).toHaveLength(2);
    expect(lastTool(p)).toMatch(/Playing 2 tracks/);
  });

  it("controls the player: pause, volume, seek, repeat, view", async () => {
    for (const [args, expected] of [
      [{ action: "pause" }, { action: "pause" }],
      [{ action: "volume", level: 30 }, { action: "volume", level: 30 }],
      [{ action: "seek", percent: 50 }, { action: "seek", percent: 50 }],
      [{ action: "repeat", mode: "one" }, { action: "repeat", mode: "one" }],
      [{ action: "view", view: "full" }, { action: "view", view: "full" }],
    ] as const) {
      screen.sent.length = 0;
      await build(new FakeProvider(one("music.control", args))).runTurn("go", ctx);
      expect(commands()[0]).toMatchObject(expected);
    }
  });

  it("manages the queue, searches, and says what is playing", async () => {
    await build(new FakeProvider(one("music.queue", { action: "add", query: "daft" }))).runTurn("go", ctx);
    expect(commands()[0]).toMatchObject({ action: "play", mode: "add" });
    const s = new FakeProvider(one("music.search", { query: "blue" }));
    await build(s).runTurn("go", ctx);
    expect(lastTool(s)).toContain("Blue in Green");
    const n = new FakeProvider(one("music.nowplaying"));
    await build(n).runTurn("go", ctx);
    expect(lastTool(n)).toMatch(/Nothing is playing/);
    expect(asked()).toEqual([]);
  });

  it("tells the model plainly when no screen is open, or a control makes no sense", async () => {
    hub.detach(screen);
    const none = new FakeProvider(one("music.control", { action: "pause" }));
    await build(none).runTurn("go", ctx);
    expect(lastTool(none)).toMatch(/No Friend screen is open/);
    hub.attach(screen);
    const bad = new FakeProvider(one("music.control", { action: "volume" }));
    await build(bad).runTurn("go", ctx);
    expect(lastTool(bad)).toMatch(/what volume/i);
  });

  it("refuses a made-up action or an extra field", async () => {
    const a = new FakeProvider(one("music.control", { action: "explode" }));
    await build(a).runTurn("go", ctx);
    expect(lastTool(a)).toMatch(/Invalid arguments/);
    const b = new FakeProvider(one("music.play", { query: "x", path: "C:\\Windows\\system32\\evil.mp3" }));
    await build(b).runTurn("go", ctx);
    expect(lastTool(b)).toMatch(/Invalid arguments/);
    expect(commands()).toHaveLength(0);
  });

  it("says music is not available without the player part", async () => {
    const p = new FakeProvider(one("music.nowplaying"));
    await build(p, false).runTurn("go", ctx);
    expect(lastTool(p)).toMatch(/not available/i);
  });
});

describe("who may control the music", () => {
  it("not a guest or a household member, and not a voice from a speaker unless the owner added the tool", async () => {
    for (const trust of ["guest", "member"] as const) {
      const p = new FakeProvider(one("music.control", { action: "pause" }));
      await build(p).runTurn("go", { ...ctx, trust });
      expect(lastTool(p)).toMatch(/not allowed/);
    }
    const voice = new FakeProvider(one("music.nowplaying"));
    await build(voice).runTurn("go", { ...ctx, trust: "voice-device" });
    expect(lastTool(voice)).toMatch(/not allowed/);
    config.alexa.extraVoiceTools = ["music.nowplaying"];
    const allowed = new FakeProvider(one("music.nowplaying"));
    await build(allowed).runTurn("go", { ...ctx, trust: "voice-device" });
    expect(lastTool(allowed)).toMatch(/Nothing is playing/);
  });
});
