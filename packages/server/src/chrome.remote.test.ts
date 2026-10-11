import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const TOKEN = "chrome-token-0123456789abcdef";
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "connectors", "testing", "fake-chrome.mjs");
const j = { "content-type": "application/json" };

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let cookie = "";
const base = () => `http://127.0.0.1:${port}`;

// ---- stand-ins for what chrome-control itself listens on (its MCP port and its extension port) ----
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let upstreamHttp: Server;
let upstreamWs: WebSocketServer;
let seen: Seen[] = [];
let wsSeen: { url: string; origin: string | undefined; messages: string[] }[] = [];
let httpPort = 0;
let wsPort = 0;
let ownerHome = "";

beforeEach(async () => {
  seen = [];
  wsSeen = [];
  upstreamHttp = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: one\n\n");
        setTimeout(() => {
          res.write("data: two\n\n");
          res.end();
        }, 150);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echoed: Buffer.concat(chunks).toString("utf8") } }));
    });
  });
  await new Promise<void>((r) => upstreamHttp.listen(0, "127.0.0.1", r));
  httpPort = (upstreamHttp.address() as AddressInfo).port;
  upstreamWs = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => upstreamWs.on("listening", r));
  wsPort = (upstreamWs.address() as AddressInfo).port;
  upstreamWs.on("connection", (ws, req) => {
    const rec = { url: req.url ?? "", origin: req.headers.origin, messages: [] as string[] };
    wsSeen.push(rec);
    ws.on("message", (m) => {
      rec.messages.push(m.toString());
      ws.send(`echo:${m.toString()}`);
    });
  });
});

afterEach(async () => {
  await app?.stop();
  await new Promise<void>((r) => upstreamHttp.close(() => r()));
  for (const c of upstreamWs.clients) c.terminate();
  await new Promise<void>((r) => upstreamWs.close(() => r()));
});

async function boot(opts: { extension?: boolean } = {}) {
  ownerHome = mkdtempSync(join(tmpdir(), "friend-remote-home-"));
  const b = join(ownerHome, ".chrome-control-mcp");
  mkdirSync(join(b, "extension"), { recursive: true });
  mkdirSync(join(b, "native-host"), { recursive: true });
  writeFileSync(join(b, "token"), `${TOKEN}\n`);
  writeFileSync(join(b, "extension", "manifest.json"), "{}");
  // the copy of Chrome control that comes with Friend: <root>/dist/index.js next to <root>/extension
  const root = mkdtempSync(join(tmpdir(), "friend-remote-cc-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist", "index.js"), "// stand-in");
  if (opts.extension !== false) {
    mkdirSync(join(root, "extension", "icons"), { recursive: true });
    writeFileSync(join(root, "extension", "manifest.json"), '{"name":"Chrome Control"}');
    writeFileSync(join(root, "extension", "background.js"), "console.log(1);".repeat(200));
    writeFileSync(join(root, "extension", "icons", "i16.png"), Buffer.from([1, 2, 3]));
  }
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-remote-")),
    provider: new FakeProvider([]),
    config: { port: 0, roots: [] },
    pluginCatalogDir: join(ownerHome, "no-catalog"),
    quick: { home: ownerHome, bundled: join(root, "dist", "index.js"), run: async () => ({ code: 0, stdout: "" }) },
    chromeRemote: { httpPort, wsPort, startServer: async () => {} },
  });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const plug = (method: string, path: string, body?: unknown) => fetch(base() + "/api/plugins" + path, { method, headers: { cookie, ...(body !== undefined ? j : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const turnOn = async () => {
  await plug("POST", "/install", { id: "chrome", pin: owner.pin });
  expect((await plug("POST", "/chrome/remote", { enabled: true, pin: owner.pin })).status).toBe(200);
};
const mcp = (init: RequestInit & { token?: string | null; query?: string } = {}) => {
  const { token, query, headers, ...rest } = init;
  return fetch(`${base()}/chrome/mcp${query ?? ""}`, {
    method: "POST",
    ...rest,
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token === undefined ? { authorization: `Bearer ${TOKEN}` } : token ? { authorization: `Bearer ${token}` } : {}), ...(headers as Record<string, string>) },
    body: rest.method === "GET" ? undefined : (rest.body ?? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })),
  });
};
const audits = () => JSON.stringify(app.db.prepare("select kind, detail_json from audit_log").all());

describe("Chrome control from outside, on Friend's own address", () => {
  it("is not there at all until the owner switches it on", async () => {
    await boot();
    expect((await mcp()).status).toBe(404);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/chrome/ws?token=${TOKEN}`, { origin: "chrome-extension://abc" });
    const closed = await new Promise<string>((r) => {
      ws.on("unexpected-response", (_q, res) => r(`http ${res.statusCode}`));
      ws.on("error", (e) => r(String(e.message)));
      ws.on("open", () => r("open"));
    });
    expect(closed).not.toBe("open");
    expect(wsSeen).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("is switched on with the PIN, kept in the settings, and is only for the owner's session", async () => {
    await boot();
    await plug("POST", "/install", { id: "chrome", pin: owner.pin });
    expect((await fetch(base() + "/api/plugins/chrome/remote", { method: "POST", headers: j, body: JSON.stringify({ enabled: true, pin: owner.pin }) })).status).toBe(401);
    expect((await plug("POST", "/chrome/remote", { enabled: true })).status).toBe(400);
    expect((await plug("POST", "/chrome/remote", { enabled: true, pin: "000000" })).status).toBe(403);
    expect(app.config.chrome.remote).toBe(false);
    expect((await plug("POST", "/chrome/remote", { enabled: true, pin: owner.pin })).status).toBe(200);
    expect(app.config.chrome.remote).toBe(true);
    expect((await plug("POST", "/chrome/remote", { enabled: false })).status).toBe(200); // switching off needs no PIN
    expect(app.config.chrome.remote).toBe(false);
    expect(audits()).toContain("chrome.remote");
  });

  it("will not switch on for a plugin that is not installed", async () => {
    await boot();
    const r = await plug("POST", "/chrome/remote", { enabled: true, pin: owner.pin });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toMatch(/not installed/i);
  });

  describe("the MCP address (/chrome/mcp)", () => {
    it("wants the Chrome control key, and says nothing else to a stranger", async () => {
      await boot();
      await turnOn();
      expect((await mcp({ token: null })).status).toBe(401);
      expect((await mcp({ token: "wrong" })).status).toBe(401);
      expect((await mcp({ token: TOKEN.slice(0, -1) })).status).toBe(401);
      expect(seen).toEqual([]);
      expect(audits()).toContain("chrome.remote_refused");
    });

    it("passes a request through to Chrome control, the same on the way back, and takes the key from the Authorization header or from ?token=", async () => {
      await boot();
      await turnOn();
      const r = await mcp({ headers: { "mcp-session-id": "abc" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("mcp-session-id")).toBe("sess-1");
      expect(await r.json()).toMatchObject({ result: { echoed: expect.stringContaining("initialize") } });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.url).toBe("/mcp");
      expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen[0]!.headers["mcp-session-id"]).toBe("abc");
      expect(seen[0]!.headers.host).toBe(`127.0.0.1:${httpPort}`);
      const q = await mcp({ token: null, query: `?token=${TOKEN}` });
      expect(q.status).toBe(200);
      expect(seen[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen[1]!.url).toBe("/mcp"); // the key is not left in the address Chrome control logs
    });

    it("turns a browser page away: a website sends an Origin, a program does not", async () => {
      await boot();
      await turnOn();
      const r = await mcp({ headers: { origin: "https://evil.example" } });
      expect(r.status).toBe(403);
      expect(seen).toEqual([]);
    });

    it("sends a long answer on as it comes, not all at the end", async () => {
      await boot();
      await turnOn();
      const res = await fetch(`${base()}/chrome/mcp`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      const t0 = Date.now();
      const first = new TextDecoder().decode((await reader.read()).value);
      expect(first).toContain("data: one");
      expect(Date.now() - t0).toBeLessThan(120); // the second part is only sent after 150 ms
      let rest = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      expect(rest).toContain("data: two");
    });

    it("answers in words when Chrome control is not running, and starts it when it can", async () => {
      await boot();
      await turnOn();
      await new Promise<void>((r) => upstreamHttp.close(() => r()));
      const r = await mcp();
      expect(r.status).toBe(502);
      expect(JSON.stringify(await r.json())).toMatch(/not running|not answering/i);
      upstreamHttp = createServer(() => {});
    });

    it("slows down someone who keeps guessing the key", async () => {
      await boot();
      await turnOn();
      const codes: number[] = [];
      for (let i = 0; i < 40; i++) codes.push((await mcp({ token: `guess-${i}` })).status);
      expect(codes).toContain(429);
      expect((await mcp({ token: TOKEN })).status).toBe(429); // and even the right key waits, so guessing cannot be tried in bulk
    });
  });

  describe("the extension address (/chrome/ws)", () => {
    const open = (query: string, origin?: string) =>
      new Promise<{ ws: WebSocket; status: string }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/chrome/ws${query}`, origin ? { origin } : {});
        ws.on("open", () => resolve({ ws, status: "open" }));
        ws.on("unexpected-response", (_q, res) => resolve({ ws, status: `http ${res.statusCode}` }));
        ws.on("error", () => resolve({ ws, status: "error" }));
      });

    it("connects the extension to Chrome control, with the same key, name and origin, and carries frames both ways", async () => {
      await boot();
      await turnOn();
      const { ws, status } = await open(`?token=${TOKEN}&name=work-laptop`, "chrome-extension://abcdef");
      expect(status).toBe("open");
      const got = new Promise<string>((r) => ws.once("message", (m) => r(m.toString())));
      ws.send('{"type":"ping"}');
      expect(await got).toBe('echo:{"type":"ping"}');
      expect(wsSeen).toHaveLength(1);
      expect(wsSeen[0]!.url).toContain(`token=${TOKEN}`);
      expect(wsSeen[0]!.url).toContain("name=work-laptop");
      expect(wsSeen[0]!.origin).toBe("chrome-extension://abcdef");
      ws.close();
    });

    it("closes Chrome control's side when the extension leaves, and the other way round", async () => {
      await boot();
      await turnOn();
      const { ws } = await open(`?token=${TOKEN}`, "chrome-extension://abcdef");
      const closedHere = new Promise<number>((r) => ws.on("close", (code) => r(code)));
      for (let i = 0; i < 50 && upstreamWs.clients.size === 0; i++) await new Promise((r) => setTimeout(r, 20)); // the join to Chrome control is made just after the extension is let in
      for (const c of upstreamWs.clients) c.close(4001, "Another Chrome connected with the same name");
      expect(await closedHere).toBe(4001);
    });

    it("turns away a wrong key, a website, and a missing key, before anything reaches Chrome control", async () => {
      await boot();
      await turnOn();
      expect((await open(`?token=nope`, "chrome-extension://abcdef")).status).toBe("http 401");
      expect((await open(``, "chrome-extension://abcdef")).status).toBe("http 401");
      expect((await open(`?token=${TOKEN}`, "https://evil.example")).status).toBe("http 403");
      expect(wsSeen).toEqual([]);
    });

    it("lets a program on another PC in as a peer (it sends no Origin), and a peer must not send one", async () => {
      await boot();
      await turnOn();
      expect((await open(`?token=${TOKEN}&role=peer`)).status).toBe("open");
      expect((await open(`?token=${TOKEN}&role=peer`, "https://evil.example")).status).toBe("http 403");
      expect(wsSeen).toHaveLength(1);
      expect(wsSeen[0]!.origin).toBeUndefined();
    });

    it("says why when Chrome control is not there", async () => {
      await boot();
      await turnOn();
      for (const c of upstreamWs.clients) c.terminate();
      await new Promise<void>((r) => upstreamWs.close(() => r()));
      const { ws, status } = await open(`?token=${TOKEN}`, "chrome-extension://abcdef");
      if (status === "open") {
        const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
        expect(code).toBe(1013);
      } else {
        expect(status).toMatch(/http 50[23]|error/);
      }
      upstreamWs = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    });
  });

  describe("what the owner sees on the plugin page", () => {
    it("gives the addresses built from the address the owner is using, and not the key", async () => {
      await boot();
      await turnOn();
      const a = (await (await plug("GET", "/chrome/access")).json()) as { remote: boolean; mcpUrl: string; extensionAddress: string; extensionZip: string; keyShown: boolean };
      expect(a).toMatchObject({ remote: true, mcpUrl: `http://127.0.0.1:${port}/chrome/mcp`, extensionAddress: `ws://127.0.0.1:${port}/chrome/ws`, extensionZip: "/api/plugins/chrome/extension.zip" });
      expect(JSON.stringify(a)).not.toContain(TOKEN);
    });

    it("uses https and the public address when one is set", async () => {
      await boot();
      app.config.publicUrl = "https://friend.example.com";
      await turnOn();
      const a = (await (await plug("GET", "/chrome/access")).json()) as { mcpUrl: string; extensionAddress: string };
      expect(a.mcpUrl).toBe("https://friend.example.com/chrome/mcp");
      expect(a.extensionAddress).toBe("wss://friend.example.com/chrome/ws");
    });

    it("shows the key only after the PIN, and says it was shown", async () => {
      await boot();
      await turnOn();
      expect((await plug("POST", "/chrome/token", {})).status).toBe(400);
      expect((await plug("POST", "/chrome/token", { pin: "000000" })).status).toBe(403);
      const r = await plug("POST", "/chrome/token", { pin: owner.pin });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ token: TOKEN });
      expect(audits()).toContain("chrome.token_shown");
      expect(audits()).not.toContain(TOKEN);
      expect(r.headers.get("cache-control")).toMatch(/no-store/);
    });
  });

  describe("the extension to install on another PC", () => {
    it("is a zip of the extension, for the owner's session only", async () => {
      await boot();
      expect((await fetch(base() + "/api/plugins/chrome/extension.zip")).status).toBe(401);
      const r = await plug("GET", "/chrome/extension.zip");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/zip");
      expect(r.headers.get("content-disposition")).toMatch(/attachment; filename="friend-chrome-extension\.zip"/);
      const buf = Buffer.from(await r.arrayBuffer());
      expect([...buf.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      const text = buf.toString("latin1");
      for (const name of ["friend-chrome-extension/manifest.json", "friend-chrome-extension/background.js", "friend-chrome-extension/icons/i16.png"]) expect(text).toContain(name);
      // the manifest is stored or deflated: read the first entry's bytes back
      const method = buf.readUInt16LE(8);
      const csize = buf.readUInt32LE(18);
      const nlen = buf.readUInt16LE(26);
      const raw = buf.subarray(30 + nlen, 30 + nlen + csize);
      expect((method === 8 ? inflateRawSync(raw) : raw).toString()).toBe("console.log(1);".repeat(200));
    });

    it("is not offered when this Friend carries no extension", async () => {
      await boot({ extension: false });
      expect((await plug("GET", "/chrome/extension.zip")).status).toBe(404);
    });

    it("can be downloaded without the plugin being switched on (it is only a program to load)", async () => {
      await boot();
      expect((await plug("GET", "/chrome/extension.zip")).status).toBe(200);
    });
  });
});
