import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "@friend/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { Approvals } from "./approvals";
import { Agent } from "./agent/loop";
import { Audit } from "./audit";
import { createApp } from "./app";
import { DEFAULT_LOOK, loadConfig, sanitizeLook } from "./config";
import { openDb } from "./db";
import { PolicyEngine } from "./policy/engine";
import { FakeProvider } from "./provider/fake";
import { applySettings, clientLook } from "./settings";
import { StageState, runStageTool } from "./stage";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot(config: object = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-look-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], ...config } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const put = (cookie: string, settings: unknown, pin?: string) =>
  fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });

afterEach(async () => {
  await app?.stop();
});

describe("the look in the config", () => {
  it("has a calm default, and keeps what was set", () => {
    const d = mkdtempSync(join(tmpdir(), "friend-look-cfg-"));
    expect(loadConfig(d).look).toEqual(DEFAULT_LOOK);
    const stored = JSON.parse(readFileSync(join(d, "config.json"), "utf8"));
    writeFileSync(join(d, "config.json"), JSON.stringify({ ...stored, look: { style: "ring", accent: "#FF00AA", size: 1.2 } }));
    expect(loadConfig(d).look).toEqual({ ...DEFAULT_LOOK, style: "ring", accent: "#ff00aa", size: 1.2 });
  });

  it("falls back, value by value, for anything that makes no sense", () => {
    expect(sanitizeLook({ style: "cube", accent: "red; background:url(x)", intensity: 9, size: -4, reactivity: "lots", ambient: "yes", captions: 1, captionSize: "huge", aiMayChange: null })).toEqual({
      ...DEFAULT_LOOK,
      intensity: 1,
      size: 0.5,
    });
    expect(sanitizeLook("nonsense")).toEqual(DEFAULT_LOOK);
    expect(sanitizeLook(null)).toEqual(DEFAULT_LOOK);
  });

  it("only a plain #rrggbb colour is accepted, so nothing else can reach the page's style", () => {
    for (const bad of ["red", "#fff", "#12345g", "#1234567", "url(javascript:x)", "#3fd8ff;"]) expect(sanitizeLook({ accent: bad }).accent, bad).toBe(DEFAULT_LOOK.accent);
  });
});

describe("changing the look from the settings screen", () => {
  it("needs no PIN, is saved, and every open screen is told", async () => {
    const cookie = await boot();
    const got: ServerMsg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    await new Promise((r) => setTimeout(r, 100));
    got.length = 0;
    const res = await put(cookie, { look: { style: "orb", accent: "#aa66ff", intensity: 0.9, size: 1.3, captionSize: "large", captions: false } });
    expect(res.status).toBe(200);
    expect(loadConfig(dir).look).toMatchObject({ style: "orb", accent: "#aa66ff", intensity: 0.9, size: 1.3, captionSize: "large", captions: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toContainEqual({ type: "stage", command: { cmd: "presence", style: "orb" } });
    expect(got).toContainEqual({ type: "stage", command: { cmd: "mood", accent: "#aa66ff", intensity: 0.9 } });
    expect(got).toContainEqual({ type: "ui", view: "companion", look: { size: 1.3, reactivity: 0.7, ambient: true, captions: false, captionSize: "large" } });
    expect(app.stage.snapshot()).toMatchObject({ presence: { style: "orb" }, mood: { accent: "#aa66ff", intensity: 0.9 } });
    ws.close();
  });

  it("still needs the PIN when anything else comes along, and refuses bad values", async () => {
    const cookie = await boot();
    expect((await put(cookie, { look: { size: 1 }, claudeCode: { model: "haiku" } })).status).toBe(400);
    expect((await put(cookie, { look: { accent: "red" } })).status).toBe(400);
    expect((await put(cookie, { look: { size: 3 } })).status).toBe(400);
    expect((await put(cookie, { look: { style: "cube" } })).status).toBe(400);
    expect((await put(cookie, { look: { shadow: true } })).status).toBe(400);
    expect(loadConfig(dir).look).toEqual(DEFAULT_LOOK);
  });

  it("is shown to a screen when it connects, and the settings carry it", async () => {
    const cookie = await boot({ look: { ...DEFAULT_LOOK, style: "ring", size: 0.8 } });
    const first = await new Promise<ServerMsg[]>((resolve) => {
      const got: ServerMsg[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
      ws.on("message", (d) => {
        got.push(JSON.parse(String(d)));
        if (got.some((m) => m.type === "ui")) {
          ws.close();
          resolve(got);
        }
      });
    });
    expect(first.find((m) => m.type === "ui")).toMatchObject({ look: { size: 0.8 } });
    expect(first.find((m) => m.type === "snapshot")).toMatchObject({ stage: { presence: { style: "ring" } } });
    const s = (await (await fetch(base() + "/api/settings", { headers: { cookie } })).json()) as { look: { style: string } };
    expect(s.look.style).toBe("ring");
  });
});

describe("the owner's look and the AI", () => {
  it("the AI may change style, colour and brightness while the owner allows it", () => {
    const stage = new StageState();
    const sent: unknown[] = [];
    const run = (name: string, args: object) => runStageTool(name, args, stage, (m) => sent.push(m));
    expect(run("stage.mood", { accent: "#ff0000", intensity: 0.2 })).toMatchObject({ ok: true, output: "ok" });
    expect(run("stage.presence", { style: "ring", state: "thinking" })).toMatchObject({ ok: true, output: "ok" });
    expect(stage.snapshot()).toMatchObject({ presence: { style: "ring", state: "thinking" }, mood: { accent: "#ff0000", intensity: 0.2 } });
  });

  it("cannot once the owner fixes it, but the animation state still works", () => {
    const stage = new StageState();
    stage.setLook({ ...DEFAULT_LOOK, style: "orb", accent: "#00ff88", aiMayChange: false });
    const sent: unknown[] = [];
    const run = (name: string, args: object) => runStageTool(name, args, stage, (m) => sent.push(m));
    expect(stage.looksLocked()).toBe(true);
    expect((run("stage.mood", { accent: "#ff0000" }) as { output: string }).output).toMatch(/owner has fixed the look/);
    expect((run("stage.presence", { style: "ring" }) as { output: string }).output).toMatch(/owner has fixed the look/);
    expect(sent).toEqual([]);
    expect(stage.snapshot()).toMatchObject({ presence: { style: "orb" }, mood: { accent: "#00ff88" } });
    // speaking, thinking and so on are not part of the look
    const state = run("stage.presence", { state: "speaking", style: "sphere" }) as { output: string };
    expect(state.output).toMatch(/owner has fixed/);
    expect(stage.snapshot().presence).toEqual({ state: "speaking", style: "orb" });
    expect(sent).toHaveLength(1);
  });

  it("setLook gives the commands that bring every screen to the new look", () => {
    const stage = new StageState();
    expect(stage.setLook({ ...DEFAULT_LOOK, style: "ring", accent: "#112233", intensity: 0.3 })).toEqual([
      { cmd: "presence", style: "ring" },
      { cmd: "mood", accent: "#112233", intensity: 0.3 },
    ]);
  });

  it("the AI changes the look with look.set when asked, without a PIN card, and it is saved", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "friend-look-agent-"));
    const db = openDb(dir2);
    const config = loadConfig(dir2);
    const request = vi.fn(async (_r: unknown) => ({ approved: true }));
    const setLook = vi.fn(() => "The look is updated and saved.");
    const provider = new FakeProvider([[{ type: "tool_call", id: "1", name: "look.set", args: { accent: "#aa66ff", size: 1.2 } }, { type: "done" }], [{ type: "done" }]]);
    const agent = new Agent({
      provider,
      policy: new PolicyEngine(db, config),
      approvals: { request } as unknown as Approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit: new Audit(db),
      config,
      assistantName: () => "Jarvis",
      settings: { get: () => ({}), set: async () => "", setView: () => "", setLook },
    });
    await agent.runTurn("make it purple and a bit bigger", { trust: "owner", emit: () => {}, ip: "1.1.1.1" });
    expect(request).not.toHaveBeenCalled();
    expect(setLook).toHaveBeenCalledWith({ accent: "#aa66ff", size: 1.2 });
    // a colour that is not #rrggbb never gets that far
    const bad = new FakeProvider([[{ type: "tool_call", id: "1", name: "look.set", args: { accent: "purple" } }, { type: "done" }], [{ type: "done" }]]);
    setLook.mockClear();
    await new Agent({ ...(agent as unknown as { deps: ConstructorParameters<typeof Agent>[0] }).deps, provider: bad }).runTurn("x", { trust: "owner", emit: () => {}, ip: "1.1.1.1" });
    expect(setLook).not.toHaveBeenCalled();
  });
});

describe("applySettings and the look", () => {
  it("merges into what is there, and names what changed", () => {
    const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-look-apply-")));
    const a = applySettings(c, { look: { accent: "#123456", captions: false } });
    expect(a.changed).toEqual(["look.accent", "look.captions"]);
    expect(a.providerChanged).toBe(false);
    expect(c.look).toEqual({ ...DEFAULT_LOOK, accent: "#123456", captions: false });
    expect(clientLook(c.look)).toEqual({ size: 1, reactivity: 0.7, ambient: true, captions: false, captionSize: "medium" });
  });
});
