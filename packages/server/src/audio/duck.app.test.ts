import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../app";
import { DEFAULT_VOICE, loadConfig } from "../config";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];

async function boot(voice: object = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-duck-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], voice: { ...DEFAULT_VOICE, ...voice } }, pluginCatalogDir: join(dir, "none") });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function connect(cookie: string) {
  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
  sockets.push(ws);
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  await new Promise<void>((res) => {
    ws.on("open", () => res());
    ws.on("error", () => res());
  });
  return { ws, msgs, ducks: () => msgs.filter((m): m is Extract<ServerMsg, { type: "audio.duck" }> => m.type === "audio.duck").map((m) => m.level), send: (m: unknown) => ws.send(JSON.stringify(m)) };
}
const put = (cookie: string, settings: unknown) => fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: owner.pin, settings }) });
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
});

describe("turning music and video down while someone talks, in the app", () => {
  it("tells every screen to turn down while one screen is listening, and back up after", async () => {
    const cookie = await boot();
    const a = await connect(cookie);
    const b = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await until(() => b.ducks().length > 0);
    expect(b.ducks()).toEqual([0.25]);
    expect(a.ducks()).toEqual([0.25]);
    a.send({ type: "audio.activity", active: false });
    await until(() => b.ducks().length > 1);
    expect(b.ducks()).toEqual([0.25, 1]);
  });

  it("also turns down the PC's own players", async () => {
    const cookie = await boot();
    const music = vi.spyOn(app.musicHost, "duck");
    const a = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await until(() => music.mock.calls.length > 0);
    expect(music).toHaveBeenLastCalledWith(0.25);
    a.send({ type: "audio.activity", active: false });
    await until(() => music.mock.calls.length > 1);
    expect(music).toHaveBeenLastCalledWith(1);
  });

  it("never leaves the sound down when the screen that asked goes away", async () => {
    const cookie = await boot();
    const a = await connect(cookie);
    const b = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await until(() => b.ducks().length > 0);
    a.ws.terminate();
    await until(() => b.ducks().length > 1);
    expect(b.ducks()).toEqual([0.25, 1]);
  });

  it("uses the level that is set, and nothing when the owner switched it off", async () => {
    const cookie = await boot({ duckPercent: 40 });
    const a = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await until(() => a.ducks().length > 0);
    expect(a.ducks()).toEqual([0.4]);
    cleanup();
  });

  it("does nothing when the owner has switched it off", async () => {
    const cookie = await boot({ duck: false });
    const a = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(a.ducks()).toEqual([]);
  });

  it("follows a change in Settings while the sound is down, and keeps it", async () => {
    const cookie = await boot();
    const a = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await until(() => a.ducks().length > 0);
    expect((await put(cookie, { voice: { duckPercent: 60 } })).status).toBe(200);
    await until(() => a.ducks().length > 1);
    expect(a.ducks()).toEqual([0.25, 0.6]);
    expect(loadConfig(dir).voice.duckPercent).toBe(60);
    expect((await put(cookie, { voice: { duck: false } })).status).toBe(200);
    await until(() => a.ducks().length > 2);
    expect(a.ducks().at(-1)).toBe(1);
  });

  it("refuses a level that is not 0 to 100", async () => {
    const cookie = await boot();
    for (const bad of [101, -1, 2.5, "loud"]) expect((await put(cookie, { voice: { duckPercent: bad } })).status, String(bad)).toBe(400);
    expect(loadConfig(dir).voice.duckPercent).toBe(25);
  });

  it("tells a screen that opens while the sound is down", async () => {
    const cookie = await boot();
    const a = await connect(cookie);
    a.send({ type: "audio.activity", active: true });
    await until(() => a.ducks().length > 0);
    const late = await connect(cookie);
    await until(() => late.ducks().length > 0);
    expect(late.ducks()).toEqual([0.25]);
  });
});

function cleanup() {
  /* sockets are closed after each test */
}
