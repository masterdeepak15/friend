import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { PRESETS } from "./connectors/presets";
import type { QuickRunner } from "./connectors/quick";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "connectors", "testing", "fake-chrome.mjs");
const chrome = PRESETS.find((p) => p.id === "chrome")!;
const real = chrome.connector;
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

async function boot(opts: { installed?: boolean; run?: QuickRunner } = {}) {
  const home = mkdtempSync(join(tmpdir(), "friend-qroute-home-"));
  if (opts.installed) installInto(home);
  const dir = mkdtempSync(join(tmpdir(), "friend-qroute-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, quick: { home, run: opts.run ?? (async () => ({ code: 0, stdout: "" })) } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, home };
}
const api = (cookie: string | null, method: string, path: string, body?: unknown) =>
  fetch(base() + "/api/connectors" + path, { method, headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

afterEach(async () => {
  chrome.connector = real;
  await app?.stop();
});
const useFake = (...extra: string[]) => {
  chrome.connector = { ...real, command: process.execPath, args: [FAKE, ...extra] };
};

describe("one-click connector routes", () => {
  it("need a signed-in owner", async () => {
    await boot();
    expect((await api(null, "GET", "/quick/chrome")).status).toBe(401);
    expect((await api(null, "POST", "/quick/chrome/install", { pin: "1" })).status).toBe(401);
    expect((await api(null, "POST", "/quick/chrome/connect", { pin: "1" })).status).toBe(401);
  });

  it("the list marks Chrome control as one click and shows the fixed command", async () => {
    const { cookie } = await boot();
    const body = (await (await api(cookie, "GET", "")).json()) as { presets: { id: string; quick?: boolean; connector: { command: string; args: string[] } }[] };
    const c = body.presets.find((p) => p.id === "chrome")!;
    expect(c.quick).toBe(true);
    expect([c.connector.command, ...c.connector.args]).toEqual(["npx", "-y", "chrome-control-mcp"]);
    expect(body.presets.find((p) => p.id === "gmail")!.quick).toBeUndefined();
  });

  it("the check needs no PIN and starts nothing: not installed says to install first", async () => {
    const { cookie } = await boot({ installed: false });
    const res = await api(cookie, "GET", "/quick/chrome");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: false, message: expect.stringMatching(/install it first/), installCommand: "npx -y chrome-control-mcp setup" });
    expect(app.audit).toBeTruthy();
    expect(((await (await api(cookie, "GET", "")).json()) as { connectors: unknown[] }).connectors).toEqual([]);
  });

  it("the check says ready when it is installed", async () => {
    const { cookie, home } = await boot({ installed: true });
    expect(await (await api(cookie, "GET", "/quick/chrome")).json()).toMatchObject({ ready: true, extensionFolder: join(home, ".chrome-control-mcp", "extension") });
  });

  it("an unknown or not one-click connector is not found", async () => {
    const { cookie } = await boot();
    for (const id of ["gmail", "nope"]) {
      expect((await api(cookie, "GET", `/quick/${id}`)).status, id).toBe(404);
      expect((await api(cookie, "POST", `/quick/${id}/connect`, { pin: owner.pin })).status, id).toBe(404);
      expect((await api(cookie, "POST", `/quick/${id}/install`, { pin: owner.pin })).status, id).toBe(404);
    }
  });

  it("connecting needs the PIN, and a wrong one starts nothing", async () => {
    useFake();
    const { cookie } = await boot({ installed: true });
    expect((await api(cookie, "POST", "/quick/chrome/connect", {})).status).toBe(400);
    expect((await api(cookie, "POST", "/quick/chrome/connect", { pin: "000000" })).status).toBe(403);
    expect(((await (await api(cookie, "GET", "")).json()) as { connectors: unknown[] }).connectors).toEqual([]);
  });

  it("connecting adds the connector in one step, and tells how the Chrome side is", async () => {
    useFake();
    const { cookie } = await boot({ installed: true });
    const res = await api(cookie, "POST", "/quick/chrome/connect", { pin: owner.pin });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, extension: "connected", connector: { id: "chrome", status: "ready" } });
    const list = (await (await api(cookie, "GET", "")).json()) as { connectors: { id: string; status: string }[] };
    expect(list.connectors).toMatchObject([{ id: "chrome", status: "ready" }]);
    const rows = app.db.prepare("select kind, detail_json from audit_log where kind = 'connector.quick_connect'").all() as { detail_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail_json).toContain('"ok":true');
  });

  it("connecting when it is not installed answers plainly and adds nothing", async () => {
    useFake();
    const { cookie } = await boot({ installed: false });
    const r = (await (await api(cookie, "POST", "/quick/chrome/connect", { pin: owner.pin })).json()) as { ok: boolean; message: string };
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Please install it first/);
    expect(((await (await api(cookie, "GET", "")).json()) as { connectors: unknown[] }).connectors).toEqual([]);
  });

  it("installing needs the PIN, runs the setup in the background, and then connecting works", async () => {
    useFake();
    const calls: string[] = [];
    let homeDir = "";
    const { cookie, home } = await boot({
      installed: false,
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        installInto(homeDir);
        return { code: 0, stdout: "" };
      },
    });
    homeDir = home;
    expect((await api(cookie, "POST", "/quick/chrome/install", {})).status).toBe(400);
    expect((await api(cookie, "POST", "/quick/chrome/install", { pin: "000000" })).status).toBe(403);
    expect(calls).toEqual([]);
    const r = (await (await api(cookie, "POST", "/quick/chrome/install", { pin: owner.pin })).json()) as { ok: boolean; extensionFolder: string };
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["npx -y chrome-control-mcp setup --no-claude --no-open --no-flag"]);
    expect(await (await api(cookie, "GET", "/quick/chrome")).json()).toMatchObject({ ready: true });
    expect(await (await api(cookie, "POST", "/quick/chrome/connect", { pin: owner.pin })).json()).toMatchObject({ ok: true });
    expect(app.db.prepare("select kind from audit_log where kind = 'connector.quick_install'").all()).toHaveLength(1);
  });

  it("a failed install says so", async () => {
    const { cookie } = await boot({ installed: false, run: async () => ({ code: 1, stdout: "npm ERR! offline" }) });
    const r = (await (await api(cookie, "POST", "/quick/chrome/install", { pin: owner.pin })).json()) as { ok: boolean; message: string; output: string };
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/did not finish/);
    expect(r.output).toContain("offline");
  });

  it("the PIN lockout applies here too", async () => {
    useFake();
    const { cookie } = await boot({ installed: true });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await api(cookie, "POST", "/quick/chrome/connect", { pin: "000000" })).status);
    expect(codes.slice(0, 3).every((c) => c === 403)).toBe(true);
    expect(codes).toContain(429);
  });
});
