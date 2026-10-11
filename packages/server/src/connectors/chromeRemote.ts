import { existsSync, readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { WebSocket } from "ws";

/** Chrome control keeps its secret key in this file once it is set up. */
export function chromeToken(home: string = homedir()): string | null {
  try {
    const t = readFileSync(join(home, ".chrome-control-mcp", "token"), "utf8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** Compares a key somebody sent with the real one without telling, by timing, how much of it was right. */
export function sameKey(given: string | null | undefined, real: string | null): boolean {
  if (!given || !real) return false;
  // both are hashed to the same length first, so the length of the real key is not learnt either
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(real).digest());
}

/** The key in an Authorization header (Bearer) or in ?token=. */
export function keyFromRequest(headers: { authorization?: string | undefined }, search: string): string | null {
  const bearer = /^Bearer (.+)$/i.exec(headers.authorization ?? "")?.[1];
  return bearer ?? new URLSearchParams(search).get("token");
}

/** The folder of the extension that comes with Friend: <copy of Chrome control>/extension, next to its dist/index.js. */
export function bundledExtensionDir(bundledIndex: string | null): string | null {
  if (!bundledIndex) return null;
  const dir = resolve(dirname(bundledIndex), "..", "extension");
  return existsSync(join(dir, "manifest.json")) ? dir : null;
}

export interface ChromeAccess {
  /** Switched on by the owner. */
  remote: boolean;
  /** The address for MCP clients on other PCs (Claude Code, Claude Desktop, ...). The key goes in an Authorization: Bearer header. */
  mcpUrl: string;
  /** What to type as the server in the extension's popup, on another PC. */
  extensionAddress: string;
  /** Where the extension can be downloaded as a zip, from the owner's signed-in screen. */
  extensionZip: string | null;
}

/** The addresses to show the owner, built from the address they reach Friend on. */
export function chromeAddresses(origin: string): { mcpUrl: string; extensionAddress: string } {
  const url = new URL(origin);
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  return { mcpUrl: `${url.origin}/chrome/mcp`, extensionAddress: `${wsScheme}//${url.host}/chrome/ws` };
}

const FORWARD_REQUEST = ["content-type", "accept", "mcp-session-id", "last-event-id", "mcp-protocol-version"];
const FORWARD_RESPONSE = ["content-type", "mcp-session-id", "cache-control", "mcp-protocol-version"];

/**
 * Sends one MCP request on to Chrome control's own server on this PC and streams what comes back. The key is put in the
 * header here, so it never travels as an address; no Origin goes on, because Chrome control refuses browser pages.
 * Resolves true when an answer was sent, false when nothing answered (so the caller can say so or start the server).
 */
export function proxyMcp(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined, up: { port: number; key: string }): Promise<boolean> {
  return new Promise((done) => {
    const headers: Record<string, string> = { authorization: `Bearer ${up.key}` };
    for (const h of FORWARD_REQUEST) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    if (body && body.length) headers["content-length"] = String(body.length);
    const out = request({ host: "127.0.0.1", port: up.port, path: "/mcp", method: req.method, headers }, (back) => {
      const h: Record<string, string> = {};
      for (const name of FORWARD_RESPONSE) {
        const v = back.headers[name];
        if (typeof v === "string") h[name] = v;
      }
      res.writeHead(back.statusCode ?? 502, h);
      back.pipe(res);
      back.on("end", () => done(true));
      back.on("error", () => {
        res.destroy();
        done(true);
      });
    });
    out.on("error", () => {
      if (res.headersSent) {
        res.destroy();
        return done(true);
      }
      done(false);
    });
    res.on("close", () => out.destroy());
    if (body && body.length) out.write(body);
    out.end();
  });
}

/** A close code that may be sent (1005, 1006 and 1015 only describe what happened and cannot be sent). */
const sendable = (code: number): number => (code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000);

/**
 * Joins one connection from outside to Chrome control's extension port on this PC: what the extension (or a peer) sends goes on,
 * what Chrome control answers comes back, and when either side leaves the other is closed. The query (key, name, role) and the
 * Origin the extension sent are passed on exactly, because Chrome control checks both itself.
 */
export function relayExtension(client: WebSocket, up: { port: number; search: string; origin: string | undefined; maxPayload: number }): void {
  const upstream = new WebSocket(`ws://127.0.0.1:${up.port}/${up.search}`, { ...(up.origin ? { origin: up.origin } : {}), maxPayload: up.maxPayload });
  const waiting: { data: Buffer; binary: boolean }[] = [];
  client.on("message", (data, binary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary });
    else if (waiting.length < 100) waiting.push({ data: buf, binary });
  });
  upstream.on("open", () => {
    for (const m of waiting.splice(0)) upstream.send(m.data, { binary: m.binary });
  });
  upstream.on("message", (data, binary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
  });
  upstream.on("close", (code, reason) => {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(sendable(code), reason.toString().slice(0, 100));
  });
  upstream.on("error", () => {
    if (client.readyState === WebSocket.OPEN) client.close(1013, "Chrome control is not reachable on this PC");
  });
  upstream.on("unexpected-response", () => {
    if (client.readyState === WebSocket.OPEN) client.close(1013, "Chrome control refused the connection");
  });
  client.on("close", (code) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close(sendable(code));
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  });
  client.on("error", () => upstream.terminate());
}
