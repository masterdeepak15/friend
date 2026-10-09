import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

let app: Awaited<ReturnType<typeof createApp>> | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

async function boot() {
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-window-")), provider: new FakeProvider([]), config: { port: 0, roots: [] } });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  /** Opens the screen's socket the way a browser tab does; resolves with how it ended up. */
  const open = (query: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, { headers: { cookie, origin: base } });
    const result = { ws, closed: null as number | null, messages: 0 };
    ws.on("message", () => result.messages++);
    ws.on("close", (code) => (result.closed = code));
    return result;
  };
  return { open };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe("Friend is open in one window at a time", () => {
  it("turns a second window away, and leaves the first working", async () => {
    const { open } = await boot();
    const first = open("?tab=a");
    await until(() => first.messages > 0);
    const second = open("?tab=b");
    await until(() => second.closed !== null);
    expect(second.closed).toBe(4409);
    expect(second.messages).toBe(0); // it was never given the screen
    expect(first.closed).toBeNull();
    first.ws.close();
  });

  it("\"Use here\" takes it over: the second window gets Friend and the first is told it was replaced", async () => {
    const { open } = await boot();
    const first = open("?tab=a");
    await until(() => first.messages > 0);
    const second = open("?tab=b&takeover=1");
    await until(() => first.closed !== null);
    expect(first.closed).toBe(4410);
    await until(() => second.messages > 0);
    expect(second.closed).toBeNull();
    second.ws.close();
  });

  it("a reload or reconnect of the same tab takes its own place back without asking", async () => {
    const { open } = await boot();
    const first = open("?tab=a");
    await until(() => first.messages > 0);
    const again = open("?tab=a");
    await until(() => again.messages > 0);
    expect(again.closed).toBeNull();
    await until(() => first.closed !== null);
    again.ws.close();
  });

  it("a window that was replaced cannot speak for Friend any more", async () => {
    const { open } = await boot();
    const first = open("?tab=a");
    await until(() => first.messages > 0);
    const second = open("?tab=b&takeover=1");
    await until(() => second.messages > 0);
    const before = second.messages;
    if (first.ws.readyState === WebSocket.OPEN) first.ws.send(JSON.stringify({ type: "chat.send", text: "hello" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(second.messages).toBe(before); // nothing was broadcast for the old window's message
    second.ws.close();
  });

  it("clients that do not name a tab (scripts, older pages) are not limited", async () => {
    const { open } = await boot();
    const a = open("");
    const b = open("");
    await until(() => a.messages > 0 && b.messages > 0);
    expect(a.closed).toBeNull();
    expect(b.closed).toBeNull();
    a.ws.close();
    b.ws.close();
  });
});
