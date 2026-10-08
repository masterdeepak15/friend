import { startDeviceNode, type DeviceNode } from "@friend/agent-cli";
import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";
import { FakeVoice, type VoiceService } from "./voice/service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const call = (id: string, name: string, args: unknown): ProviderEvent => ({ type: "tool_call", id, name, args });
const done: ProviderEvent = { type: "done" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let work = "";
let provider: FakeProvider;
const nodes: DeviceNode[] = [];
const sockets: WebSocket[] = [];

async function boot(script: ProviderEvent[][], voice?: VoiceService) {
  work = realpathSync(mkdtempSync(join(tmpdir(), "friend-int-")));
  provider = new FakeProvider(script);
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-data-")),
    provider,
    voice,
    config: { port: 0, roots: [work] },
    expireIntervalMs: 100,
    approvalTimeoutMs: 5000,
  });
  port = (await app.start()).port;
}

const base = () => `http://127.0.0.1:${port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base() + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function login(): Promise<string> {
  await post("/api/setup", owner);
  const res = await post("/api/login", { password: owner.password });
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
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  of<T extends ServerMsg["type"]>(t: T) { return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[]; }
  captions() { return this.of("caption.delta").map((m) => m.text).join(""); }
}

async function until(cond: () => boolean, ms = 6000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function addDevice() {
  const token = app.auth.redeemPairCode(app.auth.createPairCode(), "test-pc");
  const n = startDeviceNode({ url: `ws://127.0.0.1:${port}/device`, token, roots: [work], backoffMs: 100 });
  nodes.push(n);
  await n.connected;
  await until(() => app.devices.hasOnline());
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const n of nodes.splice(0)) n.stop();
  await app.stop();
});

describe("voice end to end", () => {
  const utter = (cookie: string, body = "AUDIO") =>
    fetch(base() + "/api/voice/utterance", { method: "POST", headers: { cookie, "content-type": "audio/webm" }, body });
  const clipIds = (c: Client) => [...new Set(c.of("audio.chunk").map((m) => m.id))];

  it("hears the owner, answers in captions, and speaks the reply sentence by sentence", async () => {
    const voice = new FakeVoice({ transcripts: ["status please"] });
    await boot([[text("Hello boss. All good."), done]], voice);
    const cookie = await login();
    const c = await Client.connect(cookie);
    const res = await utter(cookie);
    expect(await res.json()).toEqual({ text: "status please" });
    await until(() => clipIds(c).length === 2);
    expect(c.of("voice.heard").map((m) => m.text)).toEqual(["status please"]);
    expect(c.captions()).toContain("Hello boss.");
    expect(JSON.stringify(provider.calls[0]!.messages)).toContain("status please");
    expect(voice.synthesized).toEqual(["Hello boss.", "All good."]);
    expect(c.of("audio.chunk").filter((m) => m.last)).toHaveLength(2);
  });

  it("does not start a turn or say anything for an empty or punctuation-only transcript", async () => {
    const voice = new FakeVoice({ transcripts: ["", " ... ", "?!"] });
    await boot([[text("should not run"), done]], voice);
    const cookie = await login();
    const c = await Client.connect(cookie);
    for (let i = 0; i < 3; i++) expect(await (await utter(cookie)).json()).toEqual({ text: "" });
    await new Promise((r) => setTimeout(r, 150));
    expect(provider.calls).toHaveLength(0);
    expect(c.of("voice.heard")).toEqual([]);
    expect(voice.synthesized).toEqual([]);
  });

  it("speaks the replies to typed messages too", async () => {
    const voice = new FakeVoice();
    await boot([[text("Typed reply."), done]], voice);
    const c = await Client.connect(await login());
    c.send({ type: "chat.send", text: "hello" });
    await until(() => c.of("caption.end").length > 0);
    await until(() => c.of("audio.chunk").length > 0);
    expect(voice.synthesized).toEqual(["Typed reply."]);
  });

  it("stops speaking on voice.interrupt: audio.stop is sent and no later clip follows", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const slowSecond: VoiceService = {
      available: () => true,
      transcribe: async () => ({ text: "talk to me", language: "en" }),
      embed: async () => ({ embedding: [1], seconds: 1 }),
      synthesize: async (t) => {
        if (n++ === 1) await gate;
        return Buffer.from("RIFF" + t);
      },
    };
    await boot([[text("First part. Second part."), done]], slowSecond);
    const cookie = await login();
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => clipIds(c).length === 1);
    c.send({ type: "voice.interrupt" });
    await until(() => c.of("audio.stop").length > 0);
    release();
    await new Promise((r) => setTimeout(r, 150));
    expect(clipIds(c)).toHaveLength(1);
  });

  it("reports voice availability in status and answers 503 when it is unavailable", async () => {
    await boot([[text("x"), done]], new FakeVoice({ available: false }));
    const cookie = await login();
    const c = await Client.connect(cookie);
    await until(() => c.of("status").length > 0);
    expect(c.of("status")[0]!.voiceAvailable).toBe(false);
    expect((await utter(cookie)).status).toBe(503);
  });

  it("reports voice as unavailable when no voice service is configured", async () => {
    await boot([[text("x"), done]]);
    const cookie = await login();
    const c = await Client.connect(cookie);
    await until(() => c.of("status").length > 0);
    expect(c.of("status")[0]!.voiceAvailable).toBe(false);
    expect((await utter(cookie)).status).toBe(503);
  });

  it("an emergency lock stops a recording that is still being transcribed: no turn starts afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: VoiceService = {
      available: () => true,
      transcribe: async () => {
        await gate;
        return { text: "delete everything", language: "en" };
      },
      embed: async () => ({ embedding: [1], seconds: 1 }),
      synthesize: async (t) => Buffer.from("RIFF" + t),
    };
    await boot([[text("should never run"), done]], slow);
    const cookie = await login();
    const c = await Client.connect(cookie);
    const pending = utter(cookie);
    await new Promise((r) => setTimeout(r, 100)); // the upload is now waiting on transcription
    expect((await post("/api/lock", {}, { cookie })).status).toBe(200);
    release();
    const res = await pending;
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 150));
    expect(provider.calls).toHaveLength(0);
    expect(c.of("voice.heard")).toEqual([]);
    expect(app.agent.isBusy()).toBe(false);
  });

  it("does not speak a reply that was produced after an emergency lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const voice = new FakeVoice({ transcripts: ["tell me something"] });
    await boot([[text("Here is a secret."), done]], voice);
    const slowProvider = {
      id: "slow",
      async *stream() {
        await gate;
        yield { type: "text_delta", text: "Here is a secret." } as ProviderEvent;
        yield { type: "done" } as ProviderEvent;
      },
    };
    (app.agent as unknown as { deps: { provider: unknown } }).deps.provider = slowProvider;
    const cookie = await login();
    await utter(cookie);
    await until(() => app.agent.isBusy());
    await post("/api/lock", {}, { cookie });
    release();
    await until(() => !app.agent.isBusy());
    await new Promise((r) => setTimeout(r, 200));
    expect(voice.synthesized).toEqual([]);
  });

  it("answers 409 instead of silently dropping speech while the agent is busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const voice = new FakeVoice({ transcripts: ["first", "second"] });
    await boot([[text("ok"), done]], voice);
    (app.agent as unknown as { deps: { provider: unknown } }).deps.provider = {
      id: "slow",
      async *stream() {
        await gate;
        yield { type: "text_delta", text: "ok" } as ProviderEvent;
        yield { type: "done" } as ProviderEvent;
      },
    };
    const cookie = await login();
    const c = await Client.connect(cookie);
    expect((await utter(cookie)).status).toBe(200);
    await until(() => app.agent.isBusy());
    const second = await utter(cookie);
    expect(second.status).toBe(409);
    expect(c.of("voice.heard").map((m) => m.text)).toEqual(["first"]);
    expect(voice.transcribed).toHaveLength(1); // the second recording was refused before any transcription work
    release();
    await until(() => !app.agent.isBusy());
  });

  it("returns 502 and starts no turn when transcription fails", async () => {
    await boot([[text("x"), done]], new FakeVoice({ failTranscribe: true }));
    const cookie = await login();
    expect((await utter(cookie)).status).toBe(502);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("end to end", () => {
  it("answers a prompt with captions and runs a read tool on the device without asking", async () => {
    await boot([[call("1", "fs.list", { path: "." }), done], [text("All done"), done]]);
    await addDevice();
    const c = await Client.connect(await login());
    c.send({ type: "chat.send", text: "what is in my folder" });
    await until(() => c.of("caption.end").length > 0);
    expect(c.captions()).toContain("All done");
    expect(c.of("approval.request")).toHaveLength(0);
    expect(app.audit.list(50).some((r) => r.kind === "tool.call")).toBe(true);
  });

  it("runs a shell command only after the owner approves", async () => {
    await boot([[call("1", "shell.run", { command: "echo hello-int" }), done], [text("ran it"), done]]);
    await addDevice();
    const c = await Client.connect(await login());
    c.send({ type: "chat.send", text: "run echo" });
    await until(() => c.of("approval.request").length > 0);
    expect(c.of("approval.request")[0]!.needsPin).toBe(false);
    c.send({ type: "approval.respond", id: c.of("approval.request")[0]!.id, decision: "approve" });
    await until(() => c.of("caption.end").length > 0);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toContain("hello-int");
  });

  it("keeps a destructive command pending on a wrong PIN and runs nothing when denied", async () => {
    await boot([[call("1", "shell.run", { command: "rm -rf nothing" }), done], [text("ok"), done]]);
    await addDevice();
    const c = await Client.connect(await login());
    c.send({ type: "chat.send", text: "delete" });
    await until(() => c.of("approval.request").length > 0);
    const req = c.of("approval.request")[0]!;
    expect(req.tier).toBe("T3");
    expect(req.needsPin).toBe(true);
    c.send({ type: "approval.respond", id: req.id, decision: "approve", pin: "000000" });
    await until(() => c.of("alert").some((a) => /incorrect pin/i.test(a.text)));
    expect(app.approvals.pending()?.id).toBe(req.id);
    c.send({ type: "approval.respond", id: req.id, decision: "deny" });
    await until(() => c.of("caption.end").length > 0);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/did not approve/i);
  });

  it("does not run anything for a connection without a session", async () => {
    await boot([[text("should not run"), done]]);
    const c = await Client.connect("friend_session=bogus");
    await until(() => c.closeCode !== null);
    expect(c.closeCode).toBe(4401);
    expect(provider.calls).toHaveLength(0);
  });

  it("resyncs a reconnecting client with the pending approval and accepts one answer only", async () => {
    await boot([[call("1", "shell.run", { command: "echo once" }), done], [text("finished"), done]]);
    await addDevice();
    const cookie = await login();
    const a = await Client.connect(cookie);
    const b = await Client.connect(cookie);
    a.send({ type: "chat.send", text: "go" });
    await until(() => a.of("approval.request").length > 0 && b.of("approval.request").length > 0);
    const id = a.of("approval.request")[0]!.id;
    a.ws.terminate();
    const c = await Client.connect(cookie);
    await until(() => c.of("snapshot").length > 0);
    expect(c.of("snapshot")[0]!.pendingApproval?.id).toBe(id);
    b.send({ type: "approval.respond", id, decision: "approve" });
    c.send({ type: "approval.respond", id, decision: "approve" });
    await until(() => c.of("caption.end").length > 0);
    expect(app.audit.list(100).filter((r) => r.kind === "approval.decided")).toHaveLength(1);
    expect(app.audit.list(100).filter((r) => r.kind === "approval.ignored").length).toBeGreaterThanOrEqual(1);
    expect(provider.calls).toHaveLength(2);
  });

  it("gives a newly connected client the current stage in its snapshot", async () => {
    await boot([
      [call("1", "stage.show", { object: { id: "note", type: "card", props: { text: "hi" }, placement: "center" } }), done],
      [text("shown"), done],
    ]);
    const cookie = await login();
    const a = await Client.connect(cookie);
    a.send({ type: "chat.send", text: "show a note" });
    await until(() => a.of("caption.end").length > 0);
    const b = await Client.connect(cookie);
    await until(() => b.of("snapshot").length > 0);
    expect(b.of("snapshot")[0]!.stage.objects.map((o) => o.id)).toEqual(["note"]);
  });

  it("lets the agent show an auto-placed chart and switch the presence style; new clients see both", async () => {
    await boot([
      [
        call("1", "stage.show", {
          object: { id: "load", type: "chart", props: { kind: "line", labels: ["a", "b"], series: [{ name: "cpu", values: [1, 2] }] }, placement: "auto" },
        }),
        call("2", "stage.presence", { style: "ring" }),
        call("3", "stage.mood", { accent: "#ffb454", intensity: 0.9 }),
        done,
      ],
      [text("done"), done],
    ]);
    const cookie = await login();
    const a = await Client.connect(cookie);
    a.send({ type: "chat.send", text: "show load" });
    await until(() => a.of("caption.end").length > 0);
    const b = await Client.connect(cookie);
    await until(() => b.of("snapshot").length > 0);
    const snap = b.of("snapshot")[0]!.stage;
    expect(snap.objects.map((o) => [o.id, o.type, o.placement])).toEqual([["load", "chart", "auto"]]);
    expect(snap.presence.style).toBe("ring");
    expect(snap.mood).toEqual({ accent: "#ffb454", intensity: 0.9 });
  });

  it("answers an invalid presence style with a tool error and leaves the style alone", async () => {
    await boot([[call("1", "stage.presence", { style: "hologram" }), done], [text("ok"), done]]);
    const a = await Client.connect(await login());
    a.send({ type: "chat.send", text: "change look" });
    await until(() => a.of("caption.end").length > 0);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/invalid/i);
    expect(app.stage.snapshot().presence.style).toBe("sphere");
  });

  it("removes an object from the server stage when the owner dismisses it", async () => {
    await boot([
      [call("1", "stage.show", { object: { id: "note", type: "card", props: { text: "hi" }, placement: "center" } }), done],
      [text("shown"), done],
    ]);
    const cookie = await login();
    const a = await Client.connect(cookie);
    const b = await Client.connect(cookie);
    a.send({ type: "chat.send", text: "show a note" });
    await until(() => a.of("caption.end").length > 0);
    a.send({ type: "stage.event", objectId: "note", event: "dismiss" });
    await until(() => b.of("stage").some((m) => m.command.cmd === "hide" && m.command.id === "note"));
    expect(app.stage.snapshot().objects).toEqual([]);
  });

  it("removes objects whose ttl expires and tells clients", async () => {
    await boot([
      [call("1", "stage.show", { object: { id: "tmp", type: "card", props: { text: "x" }, placement: "center", ttl: 1 } }), done],
      [text("ok"), done],
    ]);
    const a = await Client.connect(await login());
    a.send({ type: "chat.send", text: "flash" });
    await until(() => a.of("stage").some((m) => m.command.cmd === "hide" && m.command.id === "tmp"), 4000);
    expect(app.stage.snapshot().objects).toEqual([]);
  });

  it("emergency lock revokes sessions, closes sockets and denies a pending approval", async () => {
    await boot([[call("1", "shell.run", { command: "echo x" }), done], [text("after"), done]]);
    await addDevice();
    const cookie = await login();
    const a = await Client.connect(cookie);
    a.send({ type: "chat.send", text: "go" });
    await until(() => a.of("approval.request").length > 0);
    expect((await post("/api/lock", {}, { cookie })).status).toBe(200);
    await until(() => a.closeCode !== null);
    expect(app.approvals.pending()).toBeNull();
    const again = await Client.connect(cookie);
    await until(() => again.closeCode !== null);
    expect(again.closeCode).toBe(4401);
  });

  it("shows a setup notice instead of crashing when no API key is configured", async () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "friend-int-")));
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-data-")), config: { port: 0, roots: [work], apiKey: null } });
    port = (await app.start()).port;
    const c = await Client.connect(await login());
    c.send({ type: "chat.send", text: "hello" });
    await until(() => c.of("caption.end").length > 0);
    expect(c.captions()).toMatch(/api key|friend config set/i);
  });
});
