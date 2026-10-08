/**
 * Real speaker recognition end to end: the actual sidecar (Whisper, Piper, WeSpeaker) behind the gateway.
 * Different Piper voices stand in for different people. lessac is the owner; amy and ryan are strangers.
 * Skipped, with the reason shown, when the dev voice environment or the voices are not installed.
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
const models = join(voiceDir, ".models");
const python = join(voiceDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const OWNER = "en_US-lessac-medium";
const STRANGERS = ["en_US-amy-medium", "en_US-ryan-medium"];
const installed =
  existsSync(python) &&
  existsSync(join(models, "speaker", "wespeaker_en_voxceleb_resnet34.onnx")) &&
  [OWNER, ...STRANGERS].every((v) => existsSync(join(models, "piper", `${v}.onnx`)));

const ENROLL_PHRASES = [
  "Good evening. Please open the project folder and show me the latest changes.",
  "What is the weather going to be like this evening in the city?",
  "Remind me to call the bank tomorrow morning at nine o'clock.",
];
const NEW_PHRASE = "Check my calendar and tell me what is on for tomorrow afternoon.";

describe.skipIf(!installed)("real speaker recognition end to end", () => {
  const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
  const json = { "content-type": "application/json" };
  let sidecar: SidecarProcess;
  let voice: HttpVoiceService;
  let app: Awaited<ReturnType<typeof createApp>>;
  let provider: FakeProvider;
  let base = "";
  let cookie = "";
  let ws: WebSocket;
  const msgs: ServerMsg[] = [];

  const say = (text: string, who: string) => voice.synthesize(text, who);
  const reply = (t: string) => [{ type: "text_delta" as const, text: t }, { type: "done" as const }];
  const waitFor = async (cond: () => boolean, what: string, ms = 90_000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** Sends a recording and waits for the server's decision about it. */
  async function utter(wav: Buffer): Promise<{ trust: string; turn: boolean }> {
    const seenBefore = msgs.length;
    const calls = provider.calls.length;
    const res = await fetch(base + "/api/voice/utterance", { method: "POST", headers: { cookie, "content-type": "audio/wav" }, body: new Uint8Array(wav) });
    expect(res.status).toBe(200);
    const decided = () => msgs.slice(seenBefore).find((m) => m.type === "voice.heard" || m.type === "voice.challenge");
    await waitFor(() => !!decided(), "a trust decision");
    const d = decided()!;
    const trust = d.type === "voice.heard" ? (d.trust ?? "none") : "challenge";
    if (trust === "owner" || trust === "guest") await waitFor(() => provider.calls.length > calls && !app.agent.isBusy(), "the turn to finish");
    else await new Promise((r) => setTimeout(r, 500)); // a challenge must not start a turn
    return { trust, turn: provider.calls.length > calls };
  }

  beforeAll(async () => {
    const token = "real-speaker-token";
    sidecar = new SidecarProcess({
      command: python,
      args: ["-m", "friend_voice", "--data-dir", models, "--stt-model", "base", "--tts-voice", OWNER],
      token,
      cwd: voiceDir,
      readyTimeoutMs: 180_000,
    });
    await sidecar.start();
    voice = new HttpVoiceService({ baseUrl: () => sidecar.baseUrl(), token });
    provider = new FakeProvider([reply("Owner reply."), reply("Stranger reply one."), reply("Stranger reply two."), reply("Stranger reply three.")]);
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-real-spk-")), provider, voice, config: { port: 0, roots: [] } });
    base = `http://127.0.0.1:${(await app.start()).port}`;
    await fetch(base + "/api/setup", { method: "POST", headers: json, body: JSON.stringify(owner) });
    const login = await fetch(base + "/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: owner.password }) });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { cookie, origin: base } });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));
  }, 300_000);

  afterAll(async () => {
    ws?.close();
    await app?.stop();
    await sidecar?.stop();
  });

  it("enrolls the owner's voice from three recorded phrases with the PIN", async () => {
    for (const p of ENROLL_PHRASES) {
      const res = await fetch(base + "/api/voice/enroll/sample", { method: "POST", headers: { cookie, "content-type": "audio/wav" }, body: new Uint8Array(await say(p, OWNER)) });
      expect(res.status).toBe(200);
    }
    const wrong = await fetch(base + "/api/voice/enroll/finish", { method: "POST", headers: { cookie, ...json }, body: JSON.stringify({ pin: "000000" }) });
    expect(wrong.status).toBe(403);
    const ok = await fetch(base + "/api/voice/enroll/finish", { method: "POST", headers: { cookie, ...json }, body: JSON.stringify({ pin: owner.pin }) });
    expect(ok.status).toBe(200);
    expect(app.voiceprint?.exists()).toBe(true);
    await waitFor(() => msgs.some((m) => m.type === "status" && m.voiceEnrolled === true), "the enrolled status");
  }, 240_000);

  it("accepts the owner's voice saying something new, and the turn has the owner's tools", async () => {
    const r = await utter(await say(NEW_PHRASE, OWNER));
    expect(r).toEqual({ trust: "owner", turn: true });
    expect(provider.calls[0]!.tools.length).toBeGreaterThan(0);
  }, 240_000);

  it("never accepts other voices as the owner, and strangers get no tools or history", async () => {
    for (const who of STRANGERS) {
      const r = await utter(await say(NEW_PHRASE, who));
      expect(r.trust, `${who} must not be the owner`).not.toBe("owner");
    }
    const guestCalls = provider.calls.slice(1);
    for (const c of guestCalls) {
      expect(c.tools).toEqual([]);
      expect(c.messages).toHaveLength(1);
      expect(c.system).toMatch(/unverified/i);
    }
  }, 240_000);
});
