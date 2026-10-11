import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig, saveConfig } from "./config";
import { chromeInstalled } from "./connectors/quick";
import { ConnectorStore } from "./connectors/store";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "connectors", "testing", "fake-chrome.mjs");
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

function installInto(h: string) {
  const b = join(h, ".chrome-control-mcp");
  mkdirSync(join(b, "extension"), { recursive: true });
  mkdirSync(join(b, "native-host"), { recursive: true });
  writeFileSync(join(b, "token"), "t");
  writeFileSync(join(b, "extension", "manifest.json"), "{}");
}

const runs: string[][] = [];
async function boot(opts: { setupWorks?: boolean; dataDir?: string; seed?: (dir: string, home: string) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "friend-chromeroute-home-"));
  const dir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "friend-chromeroute-"));
  opts.seed?.(dir, home);
  runs.length = 0;
  app = await createApp({
    dataDir: dir,
    provider: new FakeProvider([]),
    config: { port: 0, roots: [] },
    pluginCatalogDir: join(dir, "no-catalog"),
    quick: {
      home,
      bundled: FAKE,
      run: async (cmd, args) => {
        runs.push([cmd, ...args]);
        if (opts.setupWorks !== false) installInto(home);
        return { code: opts.setupWorks === false ? 1 : 0, stdout: "" };
      },
    },
  });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, home, dir };
}
const api = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(base() + "/api/plugins" + path, { method, headers: { cookie, ...(body !== undefined ? j : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const connectors = async (cookie: string) => ((await (await fetch(base() + "/api/connectors", { headers: { cookie } })).json()) as { connectors: { id: string; status: string; enabled: boolean; tools: number }[] }).connectors;

type View = { id: string; installed: boolean; enabled: boolean; state: string; detail: string; settings: Record<string, string> };
const chromeView = async (cookie: string): Promise<View> => ((await (await api(cookie, "GET", "")).json()) as { integrations: View[] }).integrations.find((v) => v.id === "chrome")!;
async function until(cookie: string, want: (v: View) => boolean): Promise<View> {
  let v = await chromeView(cookie);
  for (let i = 0; i < 100 && !want(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = await chromeView(cookie);
  }
  return v;
}

afterEach(async () => {
  await app?.stop();
});

describe("Chrome control as a plugin", () => {
  it("is listed with the other plugins, not installed", async () => {
    const { cookie } = await boot();
    expect(await chromeView(cookie)).toMatchObject({ installed: false, state: "not-installed" });
  });

  it("is no longer offered twice: the Connectors screen leaves it out because it is a plugin", async () => {
    const { cookie } = await boot();
    const r = (await (await fetch(base() + "/api/connectors", { headers: { cookie } })).json()) as { presets: { id: string }[] };
    expect(r.presets.map((p) => p.id)).toEqual(["gmail"]);
  });

  it("installs with the PIN, sets itself up from the copy that comes with Friend, and then waits to be switched on", async () => {
    const { cookie, home } = await boot();
    expect((await api(cookie, "POST", "/install", { id: "chrome" })).status).toBe(400);
    expect((await api(cookie, "POST", "/install", { id: "chrome", pin: "000000" })).status).toBe(403);
    expect(runs).toEqual([]);
    expect((await api(cookie, "POST", "/install", { id: "chrome", pin: owner.pin })).status).toBe(200);
    const v = await until(cookie, (x) => x.state === "off");
    expect(v).toMatchObject({ installed: true, enabled: false, state: "off" });
    expect(v.settings.extensionFolder).toBe(join(home, ".chrome-control-mcp", "extension"));
    expect(runs).toEqual([[process.execPath, FAKE, "setup", "--no-claude", "--no-open", "--no-flag"]]);
    expect(JSON.stringify(app.db.prepare("select kind, detail_json from audit_log").all())).toContain("plugin.installed");
  });

  it("shows why when the setup fails, and will not switch on until it has worked", async () => {
    const { cookie } = await boot({ setupWorks: false });
    await api(cookie, "POST", "/install", { id: "chrome", pin: owner.pin });
    const v = await until(cookie, (x) => x.state === "needs-setup" && /did not finish/.test(x.detail));
    expect(v.detail).toMatch(/did not finish/);
    const on = await api(cookie, "POST", "/chrome/enabled", { enabled: true, pin: owner.pin });
    expect(on.status).toBe(400);
    expect(JSON.stringify(await on.json())).toMatch(/not set up/i);
  });

  it("switches on with the PIN and connects; off keeps the connector; remove forgets it and leaves the helper", async () => {
    const { cookie, home } = await boot();
    await api(cookie, "POST", "/install", { id: "chrome", pin: owner.pin });
    await until(cookie, (x) => x.state === "off");
    expect((await api(cookie, "POST", "/chrome/enabled", { enabled: true })).status).toBe(400);
    expect((await api(cookie, "POST", "/chrome/enabled", { enabled: true, pin: "000000" })).status).toBe(403);
    expect((await api(cookie, "POST", "/chrome/enabled", { enabled: true, pin: owner.pin })).status).toBe(200);
    const on = await until(cookie, (x) => x.state === "online");
    expect(on).toMatchObject({ enabled: true, state: "online", detail: expect.stringMatching(/Connected to your Chrome/) });
    expect(await connectors(cookie)).toMatchObject([{ id: "chrome", status: "ready", tools: 3 }]);
    expect(app.config.chrome).toEqual({ installed: true, enabled: true });

    expect((await api(cookie, "POST", "/chrome/enabled", { enabled: false })).status).toBe(200);
    expect((await until(cookie, (x) => x.state === "off")).state).toBe("off");
    for (let i = 0; i < 50 && (await connectors(cookie))[0]?.enabled; i++) await new Promise((r) => setTimeout(r, 100)); // switching the connector off happens in the background
    expect(await connectors(cookie)).toMatchObject([{ id: "chrome", enabled: false }]);

    expect((await api(cookie, "DELETE", "/chrome")).status).toBe(200);
    expect(await chromeView(cookie)).toMatchObject({ installed: false, state: "not-installed" });
    for (let i = 0; i < 50 && (await connectors(cookie)).length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await connectors(cookie)).toEqual([]);
    expect(chromeInstalled(home).installed).toBe(true); // other programs on the PC use the helper too
  });

  it("takes over a Chrome control connector the owner already had from before it was a plugin, switched on as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-chromeroute-migrate-"));
    const { cookie } = await boot({
      dataDir: dir,
      seed: (d, h) => {
        installInto(h);
        const added = new ConnectorStore(d).add({ id: "chrome", name: "Chrome control", kind: "stdio", command: "npx", args: ["-y", "chrome-control-mcp"], env: {}, enabled: true });
        expect(added.ok).toBe(true);
      },
    });
    const v = await until(cookie, (x) => x.state === "online");
    expect(v).toMatchObject({ installed: true, enabled: true, state: "online" });
    expect(loadConfig(dir).chrome).toEqual({ installed: true, enabled: true });
  });

  it("leaves a switched-off connector from before off, and does not turn anything on by itself", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-chromeroute-migrate-off-"));
    const { cookie } = await boot({
      dataDir: dir,
      seed: (d, h) => {
        installInto(h);
        new ConnectorStore(d).add({ id: "chrome", name: "Chrome control", kind: "stdio", command: "npx", args: ["-y", "chrome-control-mcp"], env: {}, enabled: false });
      },
    });
    const v = await chromeView(cookie);
    expect(v).toMatchObject({ installed: true, enabled: false, state: "off" });
    expect((await connectors(cookie))[0]).toMatchObject({ id: "chrome", enabled: false });
  });

  it("comes back switched on after a restart, even when the saved connector pointed at a program that is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-chromeroute-restart-"));
    const { cookie } = await boot({
      dataDir: dir,
      seed: (d, h) => {
        installInto(h);
        const c = loadConfig(d);
        c.chrome = { installed: true, enabled: true };
        saveConfig(c);
        const added = new ConnectorStore(d).add({ id: "chrome", name: "Chrome control", kind: "stdio", command: "definitely-not-a-real-program", args: [], env: {}, enabled: true });
        expect(added.ok).toBe(true);
      },
    });
    const v = await until(cookie, (x) => x.state === "online");
    expect(v.state).toBe("online");
    expect(await connectors(cookie)).toMatchObject([{ id: "chrome", status: "ready" }]);
  });
});
