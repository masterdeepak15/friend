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
import { FakeVoice } from "./service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const done: ProviderEvent = { type: "done" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let provider: FakeProvider;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

async function boot(transcripts: string[]) {
  provider = new FakeProvider([[{ type: "text_delta", text: "Done." }, done]]);
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-wake-")),
    provider,
    voice: new FakeVoice({ transcripts }),
    config: { port: 0, roots: [], voice: { ...DEFAULT_VOICE } },
    expireIntervalMs: 100,
    approvalTimeoutMs: 5000,
  });
  port = (await app.start()).port;
}

async function login(): Promise<string> {
  const j = { "content-type": "application/json" };
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
  return msgs;
}

const wakeUtter = (cookie: string) => fetch(base() + "/api/voice/utterance?wake=1", { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
const pause = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("listening for the assistant's name (hands-free)", () => {
  it("drops what was said when the name was not said: no turn, nothing shown", async () => {
    await boot(["what a lovely day", "I told Jarvis to open it"]);
    const cookie = await login();
    const msgs = await connect(cookie);
    for (let i = 0; i < 2; i++) {
      const res = await wakeUtter(cookie);
      expect(await res.json()).toEqual({ text: "", wake: false });
    }
    await pause();
    expect(provider.calls).toHaveLength(0);
    expect(msgs.filter((m) => m.type === "voice.heard")).toHaveLength(0);
  });

  it("runs the request that follows the name, without the greeting and name", async () => {
    await boot(["Hey Jarvis, open the report"]);
    const cookie = await login();
    const msgs = await connect(cookie);
    const res = await wakeUtter(cookie);
    expect(await res.json()).toEqual({ text: "open the report", wake: true });
    await until(() => msgs.some((m) => m.type === "voice.heard"));
    expect(msgs.find((m) => m.type === "voice.heard")).toMatchObject({ text: "open the report" });
    await until(() => provider.calls.length === 1);
  });

  it("says it was woken, and runs nothing, when only the name was said", async () => {
    await boot(["hello Jarvis"]);
    const cookie = await login();
    const msgs = await connect(cookie);
    const res = await wakeUtter(cookie);
    expect(await res.json()).toEqual({ text: "", wake: true });
    await pause();
    expect(provider.calls).toHaveLength(0);
    expect(msgs.filter((m) => m.type === "voice.heard")).toHaveLength(0);
  });

  it("does not look for the name when the owner held the key (the ordinary route)", async () => {
    await boot(["open the report"]);
    const cookie = await login();
    await connect(cookie);
    const res = await fetch(base() + "/api/voice/utterance", { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
    expect(await res.json()).toEqual({ text: "open the report" });
    await until(() => provider.calls.length === 1);
  });
});
