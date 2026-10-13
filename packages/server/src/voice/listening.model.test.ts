import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { FakeProvider } from "../provider/fake";
import { FakeVoice } from "./service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot(voice: FakeVoice | undefined, config: object = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-listening-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), voice, config: { port: 0, roots: [], ...config } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const put = (cookie: string, settings: unknown) => fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: owner.pin, settings }) });
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};
async function watch(cookie: string) {
  const got: ServerMsg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on("open", r));
  return { got, close: () => ws.close() };
}
const alerts = (got: ServerMsg[]) => got.filter((m): m is Extract<ServerMsg, { type: "alert" }> => m.type === "alert");

afterEach(async () => {
  await app?.stop();
});

describe("choosing the listening model in the settings", () => {
  it("loads it into the running speech engine, with no restart, and says when it is ready", async () => {
    const voice = new FakeVoice();
    const cookie = await boot(voice, { voice: { sttModel: "base" } });
    const w = await watch(cookie);
    const res = await put(cookie, { voice: { sttModel: "small" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { restart: string[] }).restart).toEqual([]);
    await until(() => alerts(w.got).some((a) => /ready/.test(a.text)));
    expect(voice.modelsUsed).toEqual(["small"]);
    expect(alerts(w.got).map((a) => a.text)).toEqual([expect.stringMatching(/Getting the listening model small.*first time.*download/i), expect.stringMatching(/listening model small is ready/i)]);
    expect(loadConfig(dir).voice.sttModel).toBe("small");
    w.close();
  });

  it("goes back to the previous model, and says so, when the new one cannot be loaded", async () => {
    const voice = new FakeVoice({ failModels: ["large-v3-turbo"] });
    const cookie = await boot(voice, { voice: { sttModel: "small" } });
    const w = await watch(cookie);
    await put(cookie, { voice: { sttModel: "large-v3-turbo" } });
    await until(() => alerts(w.got).some((a) => a.level === "warn"));
    expect(app.config.voice.sttModel).toBe("small");
    expect(loadConfig(dir).voice.sttModel).toBe("small");
    expect(alerts(w.got).find((a) => a.level === "warn")!.text).toMatch(/Could not load the listening model large-v3-turbo.*internet.*small again/i);
    w.close();
  });

  it("does not fight a newer choice when an older model fails late", async () => {
    const voice = new FakeVoice({ failModels: ["medium"] });
    const cookie = await boot(voice, { voice: { sttModel: "base" } });
    await put(cookie, { voice: { sttModel: "medium" } });
    await put(cookie, { voice: { sttModel: "small" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(app.config.voice.sttModel).toBe("small");
    expect(loadConfig(dir).voice.sttModel).toBe("small");
  });

  it("is just saved when no speech engine is running (it loads at the next start)", async () => {
    const cookie = await boot(undefined);
    const res = await put(cookie, { voice: { sttModel: "small" } });
    expect(res.status).toBe(200);
    expect(loadConfig(dir).voice.sttModel).toBe("small");
  });

  it("changing something else does not reload the model", async () => {
    const voice = new FakeVoice();
    const cookie = await boot(voice);
    await put(cookie, { voice: { speakTyped: false } });
    await new Promise((r) => setTimeout(r, 100));
    expect(voice.modelsUsed).toEqual([]);
  });
});
