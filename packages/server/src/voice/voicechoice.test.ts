import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { FakeProvider } from "../provider/fake";
import { Audit } from "../audit";
import { openDb } from "../db";
import { FakeVoice } from "./service";
import { Speaker } from "./speaker";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot(voice: FakeVoice | undefined, config: object = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-voicechoice-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), voice, config: { port: 0, roots: [], ...config } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const put = (cookie: string, settings: unknown, pin: string | undefined = owner.pin) =>
  fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });
const preview = (cookie: string | null, voice: unknown) =>
  fetch(base() + "/api/voice/preview", { method: "POST", headers: { ...j, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ voice }) });
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

afterEach(async () => {
  await app?.stop();
});

describe("the speaker follows the setting", () => {
  it("uses the voice that is set at the moment each sentence is made", async () => {
    const voice = new FakeVoice();
    let current = "en_US-amy-medium";
    const speaker = new Speaker(voice, new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-spk-")))), () => current);
    await speaker.speak("First sentence.", () => {});
    current = "en_US-ryan-medium";
    await speaker.speak("Second sentence.", () => {});
    expect(voice.voicesUsed).toEqual(["en_US-amy-medium", "en_US-ryan-medium"]);
  });
  it("still takes a plain name", async () => {
    const voice = new FakeVoice();
    await new Speaker(voice, new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-spk-")))), "en_GB-alan-medium").speak("Hello there.", () => {});
    expect(voice.voicesUsed).toEqual(["en_GB-alan-medium"]);
  });
});

describe("choosing the speaking voice in the settings", () => {
  it("needs no restart: the next thing said is in the new voice, and it is saved", async () => {
    const voice = new FakeVoice();
    const cookie = await boot(voice);
    const res = await put(cookie, { voice: { ttsVoice: "en_US-amy-medium" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { restart: string[] }).restart).toEqual([]);
    expect(loadConfig(dir).voice.ttsVoice).toBe("en_US-amy-medium");
    expect(app.config.voice.ttsVoice).toBe("en_US-amy-medium");
    await until(() => voice.voicesUsed.length >= 1); // it is loaded in the background right away
    expect(voice.voicesUsed).toEqual(["en_US-amy-medium"]);
  });

  it("tells every screen the voice is loading and then ready", async () => {
    const voice = new FakeVoice();
    const cookie = await boot(voice);
    const got: ServerMsg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    await put(cookie, { voice: { ttsVoice: "en_GB-jenny_dioco-medium" } });
    await until(() => got.some((m) => m.type === "alert" && /is ready/.test(m.text)));
    const alerts = got.filter((m): m is Extract<ServerMsg, { type: "alert" }> => m.type === "alert").map((m) => m.text);
    expect(alerts[0]).toMatch(/Loading the voice Jenny \(female, British\).*60 MB/);
    expect(alerts.at(-1)).toMatch(/The voice Jenny.*is ready/);
    ws.close();
  });

  it("goes back to the previous voice, and says so, when the new one cannot be loaded", async () => {
    const voice = new FakeVoice({ failVoices: ["en_US-kristin-medium"] });
    const cookie = await boot(voice, { voice: { ttsVoice: "en_US-amy-medium" } });
    const got: ServerMsg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    await put(cookie, { voice: { ttsVoice: "en_US-kristin-medium" } });
    await until(() => got.some((m) => m.type === "alert" && m.level === "warn"));
    expect(app.config.voice.ttsVoice).toBe("en_US-amy-medium");
    expect(loadConfig(dir).voice.ttsVoice).toBe("en_US-amy-medium");
    const warn = got.find((m) => m.type === "alert" && m.level === "warn") as Extract<ServerMsg, { type: "alert" }>;
    expect(warn.text).toMatch(/Could not load the voice en_US-kristin-medium.*internet.*Amy \(female, American\) again/);
    ws.close();
  });

  it("does not fight a newer choice when an older voice fails late", async () => {
    const voice = new FakeVoice({ failVoices: ["en_US-kristin-medium"] });
    const cookie = await boot(voice, { voice: { ttsVoice: "en_US-amy-medium" } });
    await put(cookie, { voice: { ttsVoice: "en_US-kristin-medium" } });
    await put(cookie, { voice: { ttsVoice: "en_US-ryan-medium" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(app.config.voice.ttsVoice).toBe("en_US-ryan-medium");
    expect(loadConfig(dir).voice.ttsVoice).toBe("en_US-ryan-medium");
  });

  it("is just saved when no speech engine is running", async () => {
    const cookie = await boot(undefined);
    const res = await put(cookie, { voice: { ttsVoice: "en_US-ryan-medium" } });
    expect(res.status).toBe(200);
    expect(loadConfig(dir).voice.ttsVoice).toBe("en_US-ryan-medium");
  });

  it("still asks for a restart when the listening model is changed", async () => {
    const cookie = await boot(new FakeVoice());
    const res = await put(cookie, { voice: { sttModel: "base", ttsVoice: "en_US-amy-medium" } });
    expect(((await res.json()) as { restart: string[] }).restart).toEqual(["voice.sttModel"]);
  });

  it("refuses a name that could be a path", async () => {
    const cookie = await boot(new FakeVoice());
    for (const bad of ["../../x", "a b", "x;y", ""]) expect((await put(cookie, { voice: { ttsVoice: bad } })).status, bad).toBe(400);
    expect(loadConfig(dir).voice.ttsVoice).toBe("en_US-lessac-medium");
  });
});

describe("hearing a voice before choosing it", () => {
  it("needs a signed-in owner", async () => {
    await boot(new FakeVoice());
    expect((await preview(null, "en_US-amy-medium")).status).toBe(401);
  });

  it("plays a short sentence in that voice, with the assistant's name, as audio", async () => {
    const voice = new FakeVoice();
    const cookie = await boot(voice);
    const res = await preview(cookie, "en_US-amy-medium");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/audio\/wav/);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(4);
    expect(voice.voicesUsed).toEqual(["en_US-amy-medium"]);
    expect(voice.synthesized[0]).toMatch(/Hello, I am Jarvis/);
  });

  it("only voices from the list (or the one in use), never an arbitrary name", async () => {
    const voice = new FakeVoice();
    const cookie = await boot(voice);
    expect((await preview(cookie, "xx_XX-whatever-medium")).status).toBe(400);
    expect((await preview(cookie, "../../etc")).status).toBe(400);
    expect((await preview(cookie, 5)).status).toBe(400);
    expect(voice.synthesized).toEqual([]);
    expect((await preview(cookie, "en_US-lessac-medium")).status).toBe(200); // the original voice is in use
  });

  it("says so when there is no speech engine, and when a voice cannot be loaded", async () => {
    const none = await boot(undefined);
    const res = await preview(none, "en_US-amy-medium");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/friend voice setup/);
    await app.stop();
    const cookie = await boot(new FakeVoice({ failVoices: ["en_US-amy-medium"] }));
    const failed = await preview(cookie, "en_US-amy-medium");
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: string }).error).toMatch(/internet/);
  });

  it("is limited, so it cannot be used to download voices without end", async () => {
    const cookie = await boot(new FakeVoice());
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await preview(cookie, "en_US-amy-medium")).status);
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true);
    expect(codes.slice(12)).toContain(429);
  });
});
