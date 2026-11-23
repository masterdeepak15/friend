import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app";
import { sanitizeVoice, DEFAULT_VOICE } from "../config";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import type { VoiceService } from "./service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let provider: FakeProvider;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

/** A voice whose likeness to the owner's saved voice (the vector [1, 0, 0]) is exactly `likeness`. */
const voiceLike = (likeness: number): VoiceService => ({
  available: () => true,
  transcribe: async () => ({ text: "what is on my schedule", language: "en", embedding: [likeness, Math.sqrt(1 - likeness * likeness), 0] }),
  embed: async () => ({ embedding: [1, 0, 0], seconds: 1 }),
  synthesize: async (t) => Buffer.from("RIFF" + t),
});

async function boot(voice: VoiceService, unsure?: "pin" | "guest") {
  provider = new FakeProvider([[text("It is a quiet day."), done]]);
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-unsure-")), provider, voice, config: { port: 0, roots: [] }, expireIntervalMs: 100, approvalTimeoutMs: 5000 });
  if (unsure) app.config.voice.unsure = unsure;
  app.voiceprint!.enroll([[1, 0, 0]], "test"); // the owner's voice is known
  port = (await app.start()).port;
}
async function login(): Promise<string> {
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
class Client {
  msgs: ServerMsg[] = [];
  ws!: WebSocket;
  static async connect(cookie: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(c.ws);
    c.ws.on("message", (d) => c.msgs.push(JSON.parse(String(d))));
    await new Promise<void>((res) => {
      c.ws.on("open", () => res());
      c.ws.on("error", () => res());
    });
    return c;
  }
  of<T extends ServerMsg["type"]>(t: T) {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
}
async function until(cond: () => boolean, ms = 5000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const utter = (cookie: string) => fetch(base() + "/api/voice/utterance", { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body: "AUDIO" });
const pause = (ms = 250) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("a voice that is close to the owner's but not sure", () => {
  it("asks for the PIN by default, and nothing runs meanwhile", async () => {
    await boot(voiceLike(0.65));
    const cookie = await login();
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => c.of("voice.challenge").length === 1);
    await pause();
    expect(provider.calls).toHaveLength(0);
    expect(c.of("voice.heard")).toHaveLength(0);
  });

  it("is answered as a guest at once when the owner chose that: no PIN, no tools, and the owner is told what was said", async () => {
    await boot(voiceLike(0.65), "guest");
    const cookie = await login();
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => provider.calls.length === 1);
    expect(c.of("voice.challenge")).toHaveLength(0);
    expect(c.of("voice.heard")[0]).toMatchObject({ trust: "guest" });
    expect(c.of("alert").some((m) => /An unrecognized voice said/.test(m.text))).toBe(true);
    expect(provider.calls[0]!.system).toMatch(/unverified speaker/i);
    expect((provider.calls[0]!.tools ?? []).map((t) => t.name)).toEqual(["security.alert"]); // the one silent tool, nothing else
  });

  it("changes nothing for the owner's own voice or for a voice that is clearly someone else's", async () => {
    await boot(voiceLike(0.95), "guest");
    let cookie = await login();
    let c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => c.of("voice.heard").length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ trust: "owner" });
    expect(c.of("voice.challenge")).toHaveLength(0);
    for (const s of sockets.splice(0)) s.terminate();
    await app.stop();

    await boot(voiceLike(0.2));
    cookie = await login();
    c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => c.of("voice.heard").length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ trust: "guest" }); // below the PIN level it was always a guest
    expect(c.of("voice.challenge")).toHaveLength(0);
  });
});

describe("the setting", () => {
  it("is \"pin\" unless the owner chose \"guest\": any other value is read as \"pin\"", () => {
    expect(DEFAULT_VOICE.unsure).toBe("pin");
    expect(sanitizeVoice({ ...DEFAULT_VOICE, unsure: "guest" }).unsure).toBe("guest");
    expect(sanitizeVoice({ ...DEFAULT_VOICE, unsure: "nonsense" as never }).unsure).toBe("pin");
    expect(sanitizeVoice({ ...DEFAULT_VOICE, unsure: undefined as never }).unsure).toBe("pin");
  });
});
