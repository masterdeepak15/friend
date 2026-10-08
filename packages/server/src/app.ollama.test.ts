import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMsg } from "@friend/protocol";
import { createApp } from "./app";
import { DEFAULT_OLLAMA, loadConfig } from "./config";

let ollama: Server;
let ollamaUrl = "";
let requests: any[] = [];
let app: Awaited<ReturnType<typeof createApp>>;

beforeEach(async () => {
  requests = [];
  ollama = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(Buffer.concat(parts).toString() || "{}") });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ message: { role: "assistant", content: "Hello from the local model." }, done: false }) + "\n");
      res.end(JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) + "\n");
    });
  });
  await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", () => r()));
  ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
});
afterEach(async () => {
  await app?.stop();
  ollama.closeAllConnections();
  await new Promise((r) => ollama.close(r));
});

describe("config defaults", () => {
  it("defaults to Claude with local Ollama settings ready", () => {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), "friend-cfg-")));
    expect(cfg.provider).toBe("claude");
    expect(cfg.ollama).toEqual(DEFAULT_OLLAMA);
    expect(DEFAULT_OLLAMA).toEqual({ url: "http://127.0.0.1:11434", model: "qwen2.5:7b", contextTokens: 8192, vision: false });
  });
});

describe("choosing the Ollama provider", () => {
  it("answers through Ollama when config.provider is ollama, with no API key", async () => {
    app = await createApp({
      dataDir: mkdtempSync(join(tmpdir(), "friend-ollama-")),
      config: { port: 0, roots: [], apiKey: null, provider: "ollama", ollama: { url: ollamaUrl, model: "qwen2.5:7b", contextTokens: 4096 } },
    });
    const port = (await app.start()).port;
    const base = `http://127.0.0.1:${port}`;
    const json = { "content-type": "application/json" };
    await fetch(base + "/api/setup", { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "J" }) });
    const login = await fetch(base + "/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { cookie, origin: base } });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "chat.send", text: "hello" }));
    const t0 = Date.now();
    while (!msgs.some((m) => m.type === "caption.end")) {
      if (Date.now() - t0 > 5000) throw new Error("no reply");
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    expect(msgs.filter((m) => m.type === "caption.delta").map((m) => (m as { text: string }).text).join("")).toBe("Hello from the local model.");
    expect(requests[0].url).toBe("/api/chat");
    expect(requests[0].body.model).toBe("qwen2.5:7b");
    expect(requests[0].body.options.num_ctx).toBe(4096);
    expect(requests[0].body.tools.map((t: any) => t.function.name)).toContain("shell__run");
  });

  it("tells the owner how to use a local model when no key is set and the provider is Claude", async () => {
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-ollama-")), config: { port: 0, roots: [], apiKey: null } });
    const port = (await app.start()).port;
    const base = `http://127.0.0.1:${port}`;
    const json = { "content-type": "application/json" };
    await fetch(base + "/api/setup", { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "J" }) });
    const login = await fetch(base + "/api/login", { method: "POST", headers: json, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { cookie, origin: base } });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "chat.send", text: "hello" }));
    const t0 = Date.now();
    while (!msgs.some((m) => m.type === "caption.end")) {
      if (Date.now() - t0 > 5000) throw new Error("no reply");
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    const said = msgs.filter((m) => m.type === "caption.delta").map((m) => (m as { text: string }).text).join("");
    expect(said).toMatch(/api key/i);
    expect(said).toMatch(/friend ollama setup/);
  });
});
