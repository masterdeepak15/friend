import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startDeviceNode } from "@friend/agent-cli";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig, type Config } from "./config";
import { openDb } from "./db";
import { DeviceHub } from "./devices";
import { createGateway } from "./gateway";

let dir: string;
let config: Config;
let auth: Auth;
let hub: DeviceHub;
let gw: ReturnType<typeof createGateway>;
let port = 0;
let token = "";
const nodes: { stop(): void }[] = [];

function makeGateway() {
  const db = openDb(dir);
  const audit = new Audit(db);
  auth = new Auth(db, audit);
  hub = new DeviceHub();
  gw = createGateway({
    config,
    auth,
    audit,
    onClientMessage: () => {},
    onDeviceConnect: (device, ws) => hub.attach(device, ws),
  });
}

const until = async (cond: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "friend-dev-")));
  config = loadConfig(dir);
  config.port = 0;
  makeGateway();
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "J" });
  token = auth.redeemPairCode(auth.createPairCode(), "test-pc");
  port = (await gw.listen()).port;
});
afterEach(async () => {
  for (const n of nodes.splice(0)) n.stop();
  await gw.close();
});

const startNode = (t = token) => {
  const n = startDeviceNode({ url: `ws://127.0.0.1:${port}/device`, token: t, roots: [dir], backoffMs: 100 });
  nodes.push(n);
  return n;
};

describe("DeviceHub", () => {
  it("returns a clear error when no device is online", async () => {
    expect(hub.hasOnline()).toBe(false);
    expect(await hub.exec("system.info", {}, 1000)).toEqual({ ok: false, error: "no device online" });
  });
  it("reports the name of the device a call would go to", async () => {
    expect(hub.targetName()).toBeNull();
    const n = startNode();
    await n.connected;
    await until(() => hub.hasOnline());
    expect(hub.targetName()).toBe("test-pc");
  });
  it("refuses to run on a different device than the one the owner approved", async () => {
    const n = startNode();
    await n.connected;
    await until(() => hub.hasOnline());
    const r = await hub.exec("system.info", {}, 2000, { expectDevice: "some-other-pc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/some-other-pc/);
    expect((await hub.exec("system.info", {}, 5000, { expectDevice: "test-pc" })).ok).toBe(true);
  });
  it("routes a tool call to the node and returns its result", async () => {
    const n = startNode();
    await n.connected;
    await until(() => hub.hasOnline());
    const r = await hub.exec("system.info", {}, 5000);
    expect(r.ok && r.output).toMatch(/platform/);
  });
  it("resolves with an error if the node disconnects mid-call", async () => {
    const n = startNode();
    await n.connected;
    await until(() => hub.hasOnline());
    const slow = process.platform === "win32" ? "Start-Sleep 5" : "sleep 5";
    const pending = hub.exec("shell.run", { command: slow }, 20_000);
    await new Promise((r) => setTimeout(r, 300));
    n.stop();
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/disconnect/i);
  });
  it("times out a call the node never answers", async () => {
    const n = startNode();
    await n.connected;
    await until(() => hub.hasOnline());
    const slow = process.platform === "win32" ? "Start-Sleep 5" : "sleep 5";
    const r = await hub.exec("shell.run", { command: slow }, 300);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out/i);
  });
  it("reconnects after the gateway restarts", async () => {
    const n = startNode();
    await n.connected;
    await until(() => hub.hasOnline());
    await gw.close();
    config.port = port;
    makeGateway();
    await gw.listen();
    await until(() => hub.hasOnline(), 8000);
    expect((await hub.exec("system.info", {}, 5000)).ok).toBe(true);
    void n;
  });
  it("refuses a node with an invalid token and does not retry", async () => {
    const n = startNode("bogus");
    await expect(n.connected).rejects.toThrow(/unauthorized/i);
    expect(hub.hasOnline()).toBe(false);
    expect(n.state()).toBe("unauthorized");
  });
});
