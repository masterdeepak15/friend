import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createGateway } from "./gateway";
import type { ClientMsg, ServerMsg } from "@friend/protocol";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let gw: ReturnType<typeof createGateway>;
let base = "";
let port = 0;
let received: ClientMsg[] = [];
let gwAuth: Auth;
let deviceConnected = false;

beforeEach(async () => {
  received = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-gw-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  gwAuth = auth;
  deviceConnected = false;
  const config = loadConfig(dir);
  config.port = 0;
  gw = createGateway({
    config,
    auth,
    audit,
    onClientMessage: (_s, msg, conn) => {
      received.push(msg);
      if (msg.type === "ping") conn.send({ type: "status", busy: false, deviceOnline: false });
    },
    onDeviceConnect: () => { deviceConnected = true; },
  });
  port = (await gw.listen()).port;
  base = `http://127.0.0.1:${port}`;
});
afterEach(async () => { await gw.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function loginCookie(): Promise<string> {
  await post("/api/setup", owner);
  const res = await post("/api/login", { password: owner.password });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

function open(path: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; closed: Promise<number>; msgs: ServerMsg[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const msgs: ServerMsg[] = [];
    const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    ws.on("open", () => resolve({ ws, closed, msgs }));
    ws.on("error", () => resolve({ ws, closed, msgs }));
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("setup and login", () => {
  it("reports state before and after setup", async () => {
    expect(await (await fetch(base + "/api/state")).json()).toEqual({ hasOwner: false });
    await post("/api/setup", owner);
    expect(await (await fetch(base + "/api/state")).json()).toEqual({ hasOwner: true });
  });
  it("allows setup once and then returns 403", async () => {
    expect((await post("/api/setup", owner)).status).toBe(200);
    expect((await post("/api/setup", owner)).status).toBe(403);
  });
  it("refuses setup when a forwarded-for header shows a non-local origin", async () => {
    const res = await post("/api/setup", owner, { "x-forwarded-for": "8.8.8.8" });
    expect(res.status).toBe(403);
  });
  it("sets an HttpOnly SameSite=Strict cookie on login", async () => {
    await post("/api/setup", owner);
    const res = await post("/api/login", { password: owner.password });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(res.status).toBe(200);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });
  it("rejects a wrong password with 401", async () => {
    await post("/api/setup", owner);
    expect((await post("/api/login", { password: "wrong wrong wrong" })).status).toBe(401);
  });
});

describe("websocket /ws", () => {
  it("closes with 4401 when there is no cookie", async () => {
    const c = await open("/ws");
    expect(await c.closed).toBe(4401);
  });
  it("closes when the Origin is not allowed", async () => {
    const cookie = await loginCookie();
    const c = await open("/ws", { cookie, origin: "https://evil.example" });
    expect(await c.closed).toBe(4403);
  });
  it("accepts ping from an authenticated client", async () => {
    const cookie = await loginCookie();
    const c = await open("/ws", { cookie, origin: base });
    c.ws.send(JSON.stringify({ type: "ping" }));
    await wait(150);
    expect(received).toEqual([{ type: "ping" }]);
    expect(c.msgs.some((m) => m.type === "status")).toBe(true);
    c.ws.close();
  });
  it("answers invalid JSON and unknown types with an error and stays open", async () => {
    const cookie = await loginCookie();
    const c = await open("/ws", { cookie, origin: base });
    c.ws.send("{not json");
    c.ws.send(JSON.stringify({ type: "rm.rf" }));
    await wait(150);
    expect(c.msgs.filter((m) => m.type === "error")).toHaveLength(2);
    c.ws.send(JSON.stringify({ type: "ping" }));
    await wait(150);
    expect(received).toHaveLength(1);
    c.ws.close();
  });
  it("closes an oversized frame without affecting other clients", async () => {
    const cookie = await loginCookie();
    const a = await open("/ws", { cookie, origin: base });
    const b = await open("/ws", { cookie, origin: base });
    a.ws.send("x".repeat(100 * 1024));
    expect(await a.closed).toBe(1009);
    b.ws.send(JSON.stringify({ type: "ping" }));
    await wait(150);
    expect(received).toEqual([{ type: "ping" }]);
    b.ws.close();
  });
  it("closes with 4401 after logout revokes the session", async () => {
    const cookie = await loginCookie();
    await post("/api/logout", {}, { cookie });
    const c = await open("/ws", { cookie, origin: base });
    expect(await c.closed).toBe(4401);
  });
});

describe("POST /api/pair", () => {
  it("exchanges a valid code for a device token that /device accepts", async () => {
    await post("/api/setup", owner);
    const code = gwAuth.createPairCode();
    const res = await post("/api/pair", { code, name: "laptop" });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const c = await open("/device", { authorization: `Bearer ${token}` });
    await wait(100);
    expect(deviceConnected).toBe(true);
    c.ws.close();
  });
  it("rejects a wrong code and locks the caller out after repeated failures", async () => {
    await post("/api/setup", owner);
    for (let i = 0; i < 5; i++) expect((await post("/api/pair", { code: "WRONG", name: "x" })).status).toBe(400);
    expect((await post("/api/pair", { code: gwAuth.createPairCode(), name: "x" })).status).toBe(429);
  });
});

describe("websocket /device", () => {
  it("refuses an invalid device token", async () => {
    const c = await open("/device", { authorization: "Bearer bogus" });
    expect(await c.closed).toBe(4401);
  });
});
