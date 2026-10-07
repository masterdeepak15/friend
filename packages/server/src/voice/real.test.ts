/**
 * Real end to end: the actual Python sidecar with the Whisper and Piper models behind the gateway.
 * Piper speaks a question, the gateway transcribes it, the (scripted) agent answers, and the answer
 * comes back as real synthesized audio. Skipped, with the reason shown, when the dev voice
 * environment is not installed (see packages/voice).
 */
import type { ServerMsg } from "@friend/protocol";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";
import { HttpVoiceService } from "./service";
import { SidecarProcess } from "./sidecar";

const voiceDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../voice");
const python = join(voiceDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const installed = existsSync(python) && existsSync(join(voiceDir, ".models", "piper"));

describe.skipIf(!installed)("real voice end to end", () => {
  let sidecar: SidecarProcess;
  let voice: HttpVoiceService;
  let app: Awaited<ReturnType<typeof createApp>>;
  let base = "";

  beforeAll(async () => {
    const token = "real-test-token";
    sidecar = new SidecarProcess({
      command: python,
      args: ["-m", "friend_voice", "--data-dir", join(voiceDir, ".models"), "--stt-model", "base", "--tts-voice", "en_US-lessac-medium"],
      token,
      cwd: voiceDir,
      readyTimeoutMs: 180_000,
    });
    await sidecar.start();
    voice = new HttpVoiceService({ baseUrl: () => sidecar.baseUrl(), token });
    app = await createApp({
      dataDir: mkdtempSync(join(tmpdir(), "friend-real-")),
      provider: new FakeProvider([[{ type: "text_delta", text: "It is sunny today. Enjoy the afternoon." }, { type: "done" }]]),
      voice,
      config: { port: 0, roots: [] },
    });
    base = `http://127.0.0.1:${(await app.start()).port}`;
  }, 240_000);

  afterAll(async () => {
    await app?.stop();
    await sidecar?.stop();
  });

  it("the sidecar is healthy and the service reports it available", async () => {
    expect(await voice.check()).toBe(true);
    expect(voice.available()).toBe(true);
  });

  it("speaks a question and transcribes it back", async () => {
    const wav = await voice.synthesize("What is the weather today?");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    const heard = await voice.transcribe(wav, "audio/wav");
    expect(heard.text.toLowerCase()).toContain("weather");
    expect(heard.language).toBe("en");
  }, 120_000);

  it("hears the owner through the gateway, answers, and speaks the answer in real audio", async () => {
    const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
    const json = { "content-type": "application/json" };
    await fetch(base + "/api/setup", { method: "POST", headers: json, body: JSON.stringify(owner) });
    const login = await fetch(base + "/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { cookie, origin: base } });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));

    const question = await voice.synthesize("What is the weather today?");
    const res = await fetch(base + "/api/voice/utterance", {
      method: "POST",
      headers: { cookie, "content-type": "audio/wav" },
      body: new Uint8Array(question),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text.toLowerCase()).toContain("weather");

    const chunks = () => msgs.filter((m): m is Extract<ServerMsg, { type: "audio.chunk" }> => m.type === "audio.chunk");
    const t0 = Date.now();
    while (new Set(chunks().map((c) => c.id)).size < 2 || chunks().filter((c) => c.last).length < 2) {
      if (Date.now() - t0 > 60_000) throw new Error("the spoken reply did not arrive");
      await new Promise((r) => setTimeout(r, 100));
    }
    ws.close();

    expect(msgs.some((m) => m.type === "voice.heard" && /weather/i.test(m.text))).toBe(true);
    expect(msgs.filter((m) => m.type === "caption.delta").map((m) => (m as { text: string }).text).join("")).toContain("sunny");

    // the first clip is a real WAV that can be reassembled from its chunks
    const first = chunks().filter((c) => c.id === chunks()[0]!.id).sort((a, b) => a.seq - b.seq);
    const wav = Buffer.concat(first.map((c) => Buffer.from(c.data, "base64")));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.length).toBeGreaterThan(20_000);

    // and what was spoken is what the agent said
    const spoken = await voice.transcribe(wav, "audio/wav");
    expect(spoken.text.toLowerCase()).toContain("sunny");
  }, 240_000);
});
