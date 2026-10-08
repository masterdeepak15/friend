import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app";
import { DEFAULT_VOICE } from "../config";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { FakeVoice, type ScriptedUtterance } from "./service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let provider: FakeProvider;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

async function boot(utterances: (string | ScriptedUtterance)[], script: ProviderEvent[][] = [[text("Done."), done]], voiceCfg: Partial<typeof DEFAULT_VOICE> = {}) {
  provider = new FakeProvider(script);
  const voice = new FakeVoice({ transcripts: utterances });
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-trust-")),
    provider,
    voice,
    config: { port: 0, roots: [], voice: { ...DEFAULT_VOICE, ...voiceCfg } },
    expireIntervalMs: 100,
    approvalTimeoutMs: 5000,
  });
  port = (await app.start()).port;
  return voice;
}

async function login(): Promise<string> {
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

class Client {
  msgs: ServerMsg[] = [];
  closeCode: number | null = null;
  ws!: WebSocket;
  static async connect(cookie: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(c.ws);
    c.ws.on("message", (d) => c.msgs.push(JSON.parse(String(d))));
    c.ws.on("close", (code) => (c.closeCode = code));
    await new Promise<void>((res) => {
      c.ws.on("open", () => res());
      c.ws.on("error", () => res());
    });
    return c;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  of<T extends ServerMsg["type"]>(t: T) {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
}

async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const utter = (cookie: string) => fetch(base() + "/api/voice/utterance", { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
const enrollUrl = (p = "") => `${base()}/api/voice/enroll${p}`;
const sample = (cookie: string) => fetch(enrollUrl("/sample"), { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
const json = (cookie: string, method: string, path: string, body: unknown) =>
  fetch(enrollUrl(path), { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

/** Enroll "owner" with three samples through the real endpoints. */
async function enroll(cookie: string) {
  for (let i = 0; i < 3; i++) expect((await sample(cookie)).status).toBe(200);
  const res = await json(cookie, "POST", "/finish", { pin: owner.pin });
  expect(res.status).toBe(200);
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("without an enrolled voice", () => {
  it("treats every voice as the owner but marks it unverified", async () => {
    await boot([{ text: "open the report", speaker: "anyone" }]);
    const cookie = await login();
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => c.of("voice.heard").length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ text: "open the report", trust: "unverified" });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0]!.tools.length).toBeGreaterThan(0);
    await until(() => c.of("status").some((m) => m.voiceEnrolled === false));
  });
});

describe("enrollment", () => {
  it("needs a session, samples, and the PIN, then reports voiceEnrolled", async () => {
    await boot([]);
    const cookie = await login();
    const c = await Client.connect(cookie);
    expect((await fetch(enrollUrl())).status).toBe(401);
    expect((await fetch(enrollUrl("/sample"), { method: "POST", headers: { "content-type": "audio/webm" }, body: "A" })).status).toBe(401);

    expect(await (await fetch(enrollUrl(), { headers: { cookie } })).json()).toMatchObject({ enrolled: false, samples: 0, min: 3, max: 8 });
    expect(await (await sample(cookie)).json()).toMatchObject({ count: 1 });
    // too few samples
    expect((await json(cookie, "POST", "/finish", { pin: owner.pin })).status).toBe(400);
    await sample(cookie);
    await sample(cookie);
    // wrong PIN and missing PIN never commit
    expect((await json(cookie, "POST", "/finish", { pin: "000000" })).status).toBe(403);
    expect((await json(cookie, "POST", "/finish", {})).status).toBe(400);
    expect(app.auth.hasOwner()).toBe(true);
    expect((await json(cookie, "POST", "/finish", { pin: owner.pin })).status).toBe(200);
    await until(() => c.of("status").some((m) => m.voiceEnrolled === true));
    expect(await (await fetch(enrollUrl(), { headers: { cookie } })).json()).toMatchObject({ enrolled: true, samples: 0 });
  });

  it("refuses samples that are not the same person", async () => {
    const voice = new FakeVoice({ enrollSpeakers: ["owner", "owner", "other"] });
    provider = new FakeProvider([]);
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-trust-")), provider, voice, config: { port: 0, roots: [] } });
    port = (await app.start()).port;
    const cookie = await login();
    for (let i = 0; i < 3; i++) await sample(cookie);
    const res = await json(cookie, "POST", "/finish", { pin: owner.pin });
    expect(res.status).toBe(400);
    expect(app.voiceprint?.exists()).toBe(false);
  });

  it("cancel drops the samples; delete needs the PIN and removes the voiceprint", async () => {
    await boot([]);
    const cookie = await login();
    await sample(cookie);
    expect((await json(cookie, "POST", "/cancel", {})).status).toBe(200);
    expect(await (await fetch(enrollUrl(), { headers: { cookie } })).json()).toMatchObject({ samples: 0 });
    await enroll(cookie);
    expect((await json(cookie, "DELETE", "", { pin: "999999" })).status).toBe(403);
    expect(app.voiceprint?.exists()).toBe(true);
    expect((await json(cookie, "DELETE", "", { pin: owner.pin })).status).toBe(200);
    expect(app.voiceprint?.exists()).toBe(false);
  });

  it("limits how fast samples can be sent", async () => {
    await boot([]);
    const cookie = await login();
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await json(cookie, "POST", "/cancel", {})).status);
    expect(codes).toContain(429);
  });

  it("is unavailable when there is no voice service", async () => {
    provider = new FakeProvider([]);
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-trust-")), provider, config: { port: 0, roots: [] } });
    port = (await app.start()).port;
    const cookie = await login();
    expect((await fetch(enrollUrl(), { headers: { cookie } })).status).toBe(503);
  });
});

describe("after enrollment", () => {
  it("runs the owner's own voice as the owner", async () => {
    await boot([{ text: "list my files", speaker: "owner", detail: "new" }]);
    const cookie = await login();
    await enroll(cookie);
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => provider.calls.length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ text: "list my files", trust: "owner" });
    expect(provider.calls[0]!.tools.length).toBeGreaterThan(0);
  });

  it("answers a stranger as a guest: no tools, no history, nothing saved, and the owner is warned", async () => {
    const voice = await boot([{ text: "open the secret file", speaker: "stranger" }], [[text("Sorry, only for my owner."), done]]);
    const cookie = await login();
    await enroll(cookie);
    const c = await Client.connect(cookie);
    const historyBefore = (app.db.prepare("select count(*) n from messages").get() as { n: number }).n;
    await utter(cookie);
    await until(() => provider.calls.length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ text: "open the secret file", trust: "guest" });
    expect(provider.calls[0]!.tools).toEqual([]);
    expect(provider.calls[0]!.system).toMatch(/unverified/i);
    expect(provider.calls[0]!.messages).toHaveLength(1);
    await until(() => c.of("alert").some((a) => a.level === "warn" && /open the secret file/.test(a.text)));
    await until(() => voice.synthesized.length > 0); // the guest still gets a spoken answer
    expect((app.db.prepare("select count(*) n from messages").get() as { n: number }).n).toBe(historyBefore);
  });

  it("treats a recording too short to identify as needing the PIN", async () => {
    await boot([{ text: "yes" }]); // no speaker: the embedder reported too little speech
    const cookie = await login();
    await enroll(cookie);
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => c.of("voice.challenge").length === 1);
    await pause();
    expect(provider.calls).toHaveLength(0);
  });
});

describe("challenge for a borderline voice", () => {
  // The owner's own voice scores about 0.97 here, so raising "accept" above it makes it borderline.
  const borderline = { accept: 0.999, challenge: 0.5 };
  const challenged = async (words = "turn the lights off", extra: (string | ScriptedUtterance)[] = []) => {
    const voice = await boot([{ text: words, speaker: "owner", detail: "later" }, ...extra], [[text("Lights are off."), done]], borderline);
    const cookie = await login();
    await enroll(cookie);
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => c.of("voice.challenge").length === 1);
    return { cookie, c, voice, id: c.of("voice.challenge")[0]!.id };
  };

  it("holds the words back and runs nothing until the PIN is confirmed", async () => {
    const { c, id } = await challenged();
    expect(c.of("voice.challenge")[0]).toMatchObject({ text: "turn the lights off" });
    await pause();
    expect(provider.calls).toHaveLength(0);

    c.send({ type: "voice.confirm", id, pin: "000000" });
    await until(() => c.of("alert").some((a) => /incorrect pin/i.test(a.text)));
    expect(provider.calls).toHaveLength(0);
    expect(c.of("voice.challenge.end")).toEqual([]);

    c.send({ type: "voice.confirm", id, pin: owner.pin });
    await until(() => provider.calls.length === 1);
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain("turn the lights off");
    expect(provider.calls[0]!.tools.length).toBeGreaterThan(0); // confirmed: it runs as the owner
    expect(c.of("voice.challenge.end")).toEqual([{ type: "voice.challenge.end", id }]);
  });

  it("runs the confirmed words only once", async () => {
    const { c, id } = await challenged();
    c.send({ type: "voice.confirm", id, pin: owner.pin });
    await until(() => provider.calls.length === 1);
    c.send({ type: "voice.confirm", id, pin: owner.pin });
    await pause(300);
    expect(provider.calls).toHaveLength(1);
  });

  it("discards it after three wrong PINs", async () => {
    const { c, id } = await challenged();
    for (let i = 0; i < 3; i++) c.send({ type: "voice.confirm", id, pin: "000000" });
    await until(() => c.of("voice.challenge.end").length === 1);
    c.send({ type: "voice.confirm", id, pin: owner.pin });
    await pause(300);
    expect(provider.calls).toHaveLength(0);
  });

  it("is dropped when the owner cancels", async () => {
    const { c, id } = await challenged();
    c.send({ type: "voice.cancel", id });
    await until(() => c.of("voice.challenge.end").length === 1);
    c.send({ type: "voice.confirm", id, pin: owner.pin });
    await pause(300);
    expect(provider.calls).toHaveLength(0);
  });

  it("is replaced by a newer borderline utterance", async () => {
    const { cookie, c, id } = await challenged("first words", [{ text: "second words", speaker: "owner", detail: "again" }]);
    await utter(cookie);
    await until(() => c.of("voice.challenge").length === 2);
    expect(c.of("voice.challenge.end").map((m) => m.id)).toEqual([id]);
    const second = c.of("voice.challenge")[1]!;
    expect(second.text).toBe("second words");
    c.send({ type: "voice.confirm", id, pin: owner.pin }); // the old one is gone
    await pause(300);
    expect(provider.calls).toHaveLength(0);
  });

  it("is cleared by the emergency lock", async () => {
    const { cookie, c, id } = await challenged();
    expect((await fetch(base() + "/api/lock", { method: "POST", headers: { cookie } })).status).toBe(200);
    await until(() => c.of("voice.challenge.end").length === 1);
    expect(app.challenges.get(id)).toBeNull();
  });
});
