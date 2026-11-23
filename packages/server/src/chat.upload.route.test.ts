import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let provider: FakeProvider;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

async function boot(script: ProviderEvent[][] = [[text("ok"), done]], config: Record<string, unknown> = {}) {
  provider = new FakeProvider(script);
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-attachroute-")), provider, config: { port: 0, roots: [], ...config }, approvalTimeoutMs: 5000, expireIntervalMs: 100 });
  port = (await app.start()).port;
}

async function login(): Promise<string> {
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const upload = (cookie: string | null, name: string, body: Buffer | string) =>
  fetch(`${base()}/api/chat/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/octet-stream" }, body: typeof body === "string" ? body : new Uint8Array(body) });

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

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("POST /api/chat/upload", () => {
  it("needs a logged-in session", async () => {
    await boot();
    await login();
    expect((await upload(null, "a.txt", "hello")).status).toBe(401);
  });

  it("stores the file and gives back its id, with a clean name", async () => {
    await boot();
    const cookie = await login();
    const res = await upload(cookie, "..\\..\\notes.txt", "hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "notes.txt", size: 5, id: expect.stringMatching(/^[a-f0-9]{16}$/) });
  });

  it("refuses an empty file, and a file over the size the owner set", async () => {
    await boot([[text("ok"), done]], { attachments: { maxBytes: 2048 } });
    const cookie = await login();
    expect((await upload(cookie, "e.txt", Buffer.alloc(0))).status).toBe(400);
    const big = await upload(cookie, "big.bin", Buffer.alloc(4096, 1));
    expect(big.status).toBe(413);
    expect((await big.json()).error).toMatch(/limit/);
  });
});

describe("a chat message with files", () => {
  it("tells the assistant the file names and ids, and attachment.read is allowed without a card (and says so when the file is gone)", async () => {
    const call: ProviderEvent = { type: "tool_call", id: "c1", name: "attachment.read", args: { id: "0123456789abcdef" } };
    await boot([[call, done], [text("I could not open it."), done]]);
    const cookie = await login();
    const meta = (await (await upload(cookie, "plan.md", "# Plan")).json()) as { id: string; name: string };
    const c = await Client.connect(cookie);
    c.send({ type: "chat.send", text: "summarise this", attachments: [{ id: meta.id, name: meta.name }, { id: "ffffffffffffffff", name: "ghost.txt" }] });
    await until(() => provider.calls.length >= 2);
    const first = JSON.stringify(provider.calls[0]!.messages.at(-1));
    expect(first).toContain("summarise this");
    expect(first).toContain(meta.id);
    expect(first).toContain("plan.md");
    expect(first).not.toContain("ghost.txt"); // a file that was never uploaded is not mentioned
    expect(c.of("approval.request")).toHaveLength(0);
    expect(JSON.stringify(provider.calls[1]!.messages.at(-1))).toMatch(/no attached file/);
  });

  it("uses only as many files as the owner allows, and says so", async () => {
    await boot([[text("ok"), done]], { attachments: { maxFiles: 1 } });
    const cookie = await login();
    const a = (await (await upload(cookie, "a.txt", "a")).json()) as { id: string; name: string };
    const b = (await (await upload(cookie, "b.txt", "b")).json()) as { id: string; name: string };
    const c = await Client.connect(cookie);
    c.send({ type: "chat.send", text: "look", attachments: [a, b] });
    await until(() => provider.calls.length >= 1);
    const sent = JSON.stringify(provider.calls[0]!.messages.at(-1));
    expect(sent).toContain("a.txt");
    expect(sent).not.toContain("b.txt");
    await until(() => c.of("alert").some((m) => /Only the first 1 files/.test(m.text)));
  });
});
