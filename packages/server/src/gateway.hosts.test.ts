import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createGateway } from "./gateway";

let gw: ReturnType<typeof createGateway>;
let port = 0;
let auth: Auth;

async function boot(patch: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "friend-host-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  auth = new Auth(db, audit);
  const config = { ...loadConfig(dir), port: 0, ...patch };
  gw = createGateway({ config, auth, audit, onClientMessage: () => {}, onDeviceConnect: () => {} });
  port = (await gw.listen()).port;
}
afterEach(async () => { await gw.close(); });

function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const owner = { password: "correct horse battery", pin: "123456", assistantName: "J" };

describe("Host header allowlist (DNS rebinding)", () => {
  beforeEach(() => boot({ publicUrl: "https://friend.example.com", allowedHosts: ["mypc.local"] }));

  it("refuses an unknown hostname", async () => {
    expect((await call("GET", "/api/state", { host: `evil.example:${port}` })).status).toBe(421);
  });
  it("allows localhost, loopback and IP literals, the public URL host and allowedHosts", async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `192.168.1.20:${port}`, "friend.example.com", "mypc.local"]) {
      expect((await call("GET", "/api/state", { host })).status, host).toBe(200);
    }
  });
  it("refuses a websocket upgrade for an unknown hostname", async () => {
    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: "evil.example" } });
      ws.on("close", (c) => resolve(c));
      ws.on("error", () => resolve(-1));
      ws.on("unexpected-response", () => resolve(-2));
    });
    expect([-1, -2, 4403]).toContain(closed);
  });
  it("allows first-time setup only when the Host is a loopback name, even for an allowed public host", async () => {
    expect((await call("POST", "/api/setup", { host: "friend.example.com" }, owner)).status).toBe(403);
    expect(auth.hasOwner()).toBe(false);
    expect((await call("POST", "/api/setup", { host: `localhost:${port}` }, owner)).status).toBe(200);
  });
});

describe("trustProxy", () => {
  beforeEach(() => boot({ trustProxy: true }));

  it("keys the login limiter on the address the proxy appended, not on client-supplied entries", async () => {
    await call("POST", "/api/setup", { host: `localhost:${port}` }, owner);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await call("POST", "/api/login", { host: `127.0.0.1:${port}`, "x-forwarded-for": `spoof-${i}, 5.5.5.5` }, { password: "wrong password" });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
  });
});
