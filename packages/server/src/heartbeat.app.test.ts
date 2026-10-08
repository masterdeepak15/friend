import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";
import { FakeVoice } from "./voice/service";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

async function boot(voice?: FakeVoice, script: ProviderEvent[][] = []) {
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-hb-")),
    provider: new FakeProvider(script),
    voice,
    config: { port: 0, roots: [] },
    heartbeatMs: 40,
    expireIntervalMs: 100,
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
  await new Promise<void>((r) => ws.on("open", () => r()));
  return msgs;
}

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

describe("reminders in the running app", () => {
  it("shows an alert and a card, speaks the reminder, audits it, and tells the owner only once", async () => {
    const voice = new FakeVoice();
    await boot(voice);
    const cookie = await login();
    const msgs = await connect(cookie);
    app.tasks.add({ title: "Call the bank", dueAt: Date.now() + 120 });

    await until(() => msgs.some((m) => m.type === "alert" && /Reminder: Call the bank/.test(m.text)));
    const card = msgs.find((m) => m.type === "stage" && m.command.cmd === "show" && m.command.object.id.startsWith("reminder-"));
    expect(card).toMatchObject({ command: { object: { type: "card", props: { text: "Call the bank" }, style: "alert", ttl: 90 } } });
    await until(() => voice.synthesized.some((s) => /Reminder.*Call the bank/.test(s)));
    expect(JSON.stringify(app.db.prepare("select kind from audit_log").all())).toContain("task.fired");

    await new Promise((r) => setTimeout(r, 250));
    expect(msgs.filter((m) => m.type === "alert" && /Reminder/.test(m.text))).toHaveLength(1);
    expect(app.tasks.list()).toHaveLength(1); // still open until the owner marks it done
  });

  it("holds the reminder until the owner opens a screen", async () => {
    await boot();
    const cookie = await login();
    app.tasks.add({ title: "Water the plants", dueAt: Date.now() + 60 });
    await new Promise((r) => setTimeout(r, 250));
    expect(app.tasks.due()).toHaveLength(1);
    const msgs = await connect(cookie);
    await until(() => msgs.some((m) => m.type === "alert" && /Water the plants/.test(m.text)));
  });

  it("never starts a model turn for a reminder", async () => {
    await boot(undefined, [[text("should never run"), done]]);
    const cookie = await login();
    const msgs = await connect(cookie);
    app.tasks.add({ title: "Stretch", dueAt: Date.now() + 60 });
    await until(() => msgs.some((m) => m.type === "alert" && /Stretch/.test(m.text)));
    expect(msgs.some((m) => m.type === "caption.delta")).toBe(false);
    expect((app.agent as unknown as { deps: { provider: FakeProvider } }).deps.provider.calls).toHaveLength(0);
  });

  it("a task added by the agent through a conversation reaches the heartbeat", async () => {
    await boot(undefined, [
      [{ type: "tool_call", id: "1", name: "task.add", args: { title: "Take the pills", inMinutes: 1 } }, done],
      [text("I will remind you."), done],
    ]);
    const cookie = await login();
    const msgs = await connect(cookie);
    const ws = sockets[0]!;
    ws.send(JSON.stringify({ type: "chat.send", text: "remind me in a minute to take the pills" }));
    await until(() => msgs.some((m) => m.type === "caption.end"));
    expect(app.tasks.list()).toMatchObject([{ title: "Take the pills" }]);
  });
});
