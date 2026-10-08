import { createApp, loadConfig } from "@friend/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { IO } from "./cli";
import { configCommand } from "./commands/config";
import { lanAddresses, lanCommand, urlsFor, type Interfaces } from "./commands/lan";

const fakeIfaces: Interfaces = () =>
  ({
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    "Wi-Fi": [
      { address: "fe80::1", family: "IPv6", internal: false },
      { address: "192.168.1.20", family: "IPv4", internal: false },
    ],
    Ethernet: [{ address: "10.0.0.7", family: "IPv4", internal: false }],
    Down: undefined,
  }) as unknown as ReturnType<Interfaces>;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "friend-lan-"));
  const i: IO = { dataDir, out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  return { i, out, err, dataDir, text: () => out.join("\n") };
}

describe("addresses", () => {
  it("finds this PC's IPv4 addresses on the network, not loopback or IPv6", () => {
    expect(lanAddresses(fakeIfaces)).toEqual(["192.168.1.20", "10.0.0.7"]);
  });
  it("tells which addresses Friend can be opened at", () => {
    expect(urlsFor("127.0.0.1", 8787, fakeIfaces)).toEqual({ local: "http://127.0.0.1:8787", network: [] });
    expect(urlsFor("localhost", 8787, fakeIfaces).network).toEqual([]);
    expect(urlsFor("0.0.0.0", 9000, fakeIfaces)).toEqual({ local: "http://127.0.0.1:9000", network: ["http://192.168.1.20:9000", "http://10.0.0.7:9000"] });
    expect(urlsFor("192.168.1.20", 9000, fakeIfaces).network).toEqual(["http://192.168.1.20:9000"]);
  });
});

describe("friend lan", () => {
  it("says it is only on this PC by default", async () => {
    const t = io();
    expect(await lanCommand([], t.i, fakeIfaces)).toBe(0);
    expect(t.text()).toMatch(/127\.0\.0\.1:8787/);
    expect(t.text()).toMatch(/not reachable.*friend lan on/s);
  });

  it("on: opens it to the network, lists the addresses, keeps the port, and warns", async () => {
    const t = io();
    expect(await lanCommand(["on"], t.i, fakeIfaces)).toBe(0);
    const c = loadConfig(t.dataDir);
    expect([c.bind, c.port]).toEqual(["0.0.0.0", 8787]);
    expect(t.text()).toContain("http://192.168.1.20:8787");
    expect(t.text()).toContain("http://10.0.0.7:8787");
    expect(t.text()).toMatch(/Restart Friend/);
    expect(t.text()).toMatch(/plain http/);
    expect(t.text()).toMatch(/microphone and camera/);
    expect(t.text()).toMatch(/firewall/i);
  });

  it("on --port changes the port at the same time", async () => {
    const t = io();
    await lanCommand(["on", "--port", "9100"], t.i, fakeIfaces);
    const c = loadConfig(t.dataDir);
    expect([c.bind, c.port]).toEqual(["0.0.0.0", 9100]);
    expect(t.text()).toContain("http://192.168.1.20:9100");
  });

  it("port N changes only the port, off closes it again", async () => {
    const t = io();
    await lanCommand(["on"], t.i, fakeIfaces);
    await lanCommand(["port", "9200"], t.i, fakeIfaces);
    expect(loadConfig(t.dataDir)).toMatchObject({ bind: "0.0.0.0", port: 9200 });
    await lanCommand(["off"], t.i, fakeIfaces);
    expect(loadConfig(t.dataDir)).toMatchObject({ bind: "127.0.0.1", port: 9200 });
  });

  it("refuses a port that makes no sense and changes nothing", async () => {
    for (const bad of ["80", "70000", "abc", "", "1.5", "-1"]) {
      const t = io();
      await expect(lanCommand(["port", bad], t.i, fakeIfaces)).rejects.toThrow(/1024 to 65535/);
      await expect(lanCommand(["on", "--port", bad], t.i, fakeIfaces)).rejects.toThrow(/1024 to 65535/);
      expect(loadConfig(t.dataDir)).toMatchObject({ bind: "127.0.0.1", port: 8787 });
    }
    const t = io();
    await expect(lanCommand(["on", "--port"], t.i, fakeIfaces)).rejects.toThrow(/1024 to 65535/);
  });

  it("shows usage for anything else", async () => {
    const t = io();
    expect(await lanCommand(["wide-open"], t.i, fakeIfaces)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage/);
  });

  it("says when there is no network address to give out", async () => {
    const t = io();
    await lanCommand(["on"], t.i, () => ({}) as ReturnType<Interfaces>);
    expect(t.text()).toMatch(/no network address found/);
  });
});

describe("friend config set bind", () => {
  it("accepts an address or localhost and refuses anything else", async () => {
    const t = io();
    expect(await configCommand(["set", "bind", "0.0.0.0"], t.i)).toBe(0);
    expect(await configCommand(["set", "bind", "192.168.1.20"], t.i)).toBe(0);
    expect(await configCommand(["set", "bind", "localhost"], t.i)).toBe(0);
    for (const bad of ["everywhere", "", "1.2.3", "my-pc", "0.0.0.0; rm"]) await expect(configCommand(["set", "bind", bad], t.i)).rejects.toThrow(/IP address/);
  });
});

let app: Awaited<ReturnType<typeof createApp>> | null = null;
afterEach(async () => {
  await app?.stop();
  app = null;
});

describe("really opened to the network", () => {
  const ip = lanAddresses()[0];

  it.skipIf(!ip)("can be signed in to and used through this PC's network address", async () => {
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-lan-live-")), config: { bind: "0.0.0.0", port: 0, roots: [] } });
    const { port } = await app.start();
    const base = `http://${ip}:${port}`;
    const j = { "content-type": "application/json" };
    // the owner is created on this PC (setup is refused from anywhere else), then used from the network address
    const setup = await fetch(`http://127.0.0.1:${port}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
    expect(setup.status).toBe(200);
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual({ hasOwner: true });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const ws = new WebSocket(`ws://${ip}:${port}/ws`, { headers: { cookie, origin: base } });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on("message", () => {
        ws.close();
        resolve(true);
      });
      ws.on("error", () => resolve(false));
      ws.on("close", () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  it.skipIf(!ip)("still refuses to create the owner from another address", async () => {
    app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-lan-live-")), config: { bind: "0.0.0.0", port: 0, roots: [] } });
    const { port } = await app.start();
    const res = await fetch(`http://${ip}:${port}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
    expect(res.status).toBe(403);
  });
});
