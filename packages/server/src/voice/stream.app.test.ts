import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app";
import { DEFAULT_VOICE } from "../config";
import type { Provider, ProviderEvent, StreamRequest } from "../provider/types";
import { FakeVoice } from "./service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

/** Writes its reply slowly, the way a local model does: a sentence, a pause, another sentence. */
class SlowWriter implements Provider {
  id = "slow";
  constructor(private pieces: string[], private gapMs: number) {}
  async *stream(_req: StreamRequest): AsyncIterable<ProviderEvent> {
    for (const p of this.pieces) {
      yield { type: "text_delta", text: p };
      await new Promise((r) => setTimeout(r, this.gapMs));
    }
    yield { type: "done" };
  }
}

async function boot(provider: Provider, voice = new FakeVoice({ transcripts: ["tell me something"] }), voiceCfg: Partial<typeof DEFAULT_VOICE> = {}) {
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-streamapp-")),
    provider,
    voice,
    config: { port: 0, roots: [], voice: { ...DEFAULT_VOICE, ...voiceCfg } },
  });
  port = (await app.start()).port;
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const msgs: ServerMsg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
  sockets.push(ws);
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { cookie, msgs, ws, voice };
}
const utter = (cookie: string) => fetch(base() + "/api/voice/utterance", { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
async function until(cond: () => boolean, ms = 6000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("speaking while the reply is still being written", () => {
  it("sends the first sentence's audio before the reply has finished", async () => {
    const { cookie, msgs } = await boot(new SlowWriter(["The first sentence is ready. ", "The second one comes later. ", "And a third."], 250));
    await utter(cookie);
    await until(() => msgs.some((m) => m.type === "audio.chunk"));
    expect(msgs.some((m) => m.type === "caption.end")).toBe(false); // still writing when the voice started
    await until(() => msgs.filter((m) => m.type === "audio.chunk" && m.last).length === 3);
    const firstAudio = msgs.findIndex((m) => m.type === "audio.chunk");
    const end = msgs.findIndex((m) => m.type === "caption.end");
    expect(firstAudio).toBeLessThan(end === -1 ? Infinity : end);
  });

  it("speaks everything in order, with nothing left out or said twice", async () => {
    const { cookie, msgs, voice } = await boot(new SlowWriter(["Alpha one. Alpha two. ", "Beta one.\nBeta two"], 40));
    await utter(cookie);
    await until(() => msgs.filter((m) => m.type === "audio.chunk" && m.last).length === 4);
    expect(voice.synthesized).toEqual(["Alpha one.", "Alpha two.", "Beta one.", "Beta two."]);
  });

  it("speaks a typed reply as it is written, just like one to a spoken request", async () => {
    const { msgs, ws, voice } = await boot(new SlowWriter(["Typed reply one. ", "Typed reply two."], 150));
    ws.send(JSON.stringify({ type: "chat.send", text: "hello" }));
    await until(() => msgs.some((m) => m.type === "audio.chunk"));
    expect(msgs.some((m) => m.type === "caption.end")).toBe(false); // the voice started while it was still being written
    await until(() => msgs.filter((m) => m.type === "audio.chunk" && m.last).length === 2);
    expect(voice.synthesized).toEqual(["Typed reply one.", "Typed reply two."]);
  });

  it("stays silent for typed messages when the owner turned that off", async () => {
    const { msgs, ws, voice } = await boot(new SlowWriter(["Typed reply. "], 10), new FakeVoice(), { speakTyped: false });
    ws.send(JSON.stringify({ type: "chat.send", text: "hello" }));
    await until(() => msgs.some((m) => m.type === "caption.end"));
    await new Promise((r) => setTimeout(r, 150));
    expect(voice.synthesized).toEqual([]);
    expect(msgs.some((m) => m.type === "audio.chunk")).toBe(false);
  });

  it("stays silent after the emergency lock", async () => {
    const { cookie, msgs, voice } = await boot(new SlowWriter(["One. ", "Two. ", "Three. ", "Four."], 200));
    await utter(cookie);
    await until(() => voice.synthesized.length >= 1);
    await fetch(base() + "/api/lock", { method: "POST", headers: { cookie } });
    const spokenAtLock = voice.synthesized.length;
    await new Promise((r) => setTimeout(r, 900));
    expect(voice.synthesized.length).toBeLessThanOrEqual(spokenAtLock + 1); // at most the clip already being made
    expect(msgs.some((m) => m.type === "audio.stop")).toBe(true);
  });
});
