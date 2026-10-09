import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { FakeVoice } from "./service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const done: ProviderEvent = { type: "done" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
});

async function boot(script: ProviderEvent[][]) {
  const provider = new FakeProvider(script);
  const voice = new FakeVoice({ transcripts: [{ text: "आज का weather बताओ" }] });
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-lang-")), provider, voice, config: { port: 0, roots: [] } });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
  sockets.push(ws);
  await new Promise<void>((r) => {
    ws.on("open", () => r());
    ws.on("error", () => r());
  });
  return { provider, voice, send: (m: unknown) => ws.send(JSON.stringify(m)), base, cookie };
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 15));
  expect(cond()).toBe(true);
};

describe("answering in the owner's language", () => {
  it("always tells the model to write Hindi and Marathi in Devanagari and keep English words in Latin letters", async () => {
    const { provider, send } = await boot([[{ type: "text_delta", text: "ok" }, done]]);
    send({ type: "chat.send", text: "hello" });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0]!.system).toMatch(/Devanagari script, never in Roman letters/);
    expect(provider.calls[0]!.context).not.toMatch(/Language:/); // plain English adds no extra line
  });

  it("adds a line when the owner types Hindi", async () => {
    const { provider, send } = await boot([[{ type: "text_delta", text: "ठीक है।" }, done]]);
    send({ type: "chat.send", text: "आज मौसम कैसा है" });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0]!.context).toMatch(/Language: the owner is speaking Hindi\. Answer in Hindi, written in Devanagari script/);
  });

  it("adds the mixing line when the owner mixes, and speaks the reply with the right voices", async () => {
    const { provider, voice, send } = await boot([[{ type: "text_delta", text: "आज का weather बहुत अच्छा है।" }, done]]);
    send({ type: "chat.send", text: "आज का weather बताओ" });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0]!.context).toMatch(/mixing Hindi and English/);
    await until(() => voice.synthesized.length === 3);
    expect(voice.voicesUsed).toEqual(["hi_IN-priyamvada-medium", "en_US-lessac-medium", "hi_IN-priyamvada-medium"]);
  });

  it("adds a line from what the recognizer heard when a spoken request comes in", async () => {
    const { provider, base, cookie } = await boot([[{ type: "text_delta", text: "ok" }, done]]);
    const res = await fetch(`${base}/api/voice/utterance`, { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
    expect(res.status).toBe(200);
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0]!.context).toMatch(/Language: the owner is mixing Hindi and English/);
  });
});
