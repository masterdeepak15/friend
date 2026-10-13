import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ChromePlugin } from "./connectors/chromePlugin";
import type { McpHub } from "./connectors/hub";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "connectors", "testing", "fake-chrome.mjs");
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

const STATUS = { platform: "win32", running: true, hidden: false, shortcuts: { patched: 0, already: 0, failed: 0, withFlag: 0, total: 8 } };
const calls: string[][] = [];
const normal = (cmd: string): { code: number; stdout: string } => ({ code: 0, stdout: cmd === "flag-status" ? JSON.stringify(STATUS) : cmd === "flag" ? JSON.stringify({ ok: true, counts: { patched: 3, already: 0, failed: 1, withFlag: 3, total: 4 } }) : JSON.stringify({ ok: true, message: "Chrome was restarted with the banner hidden. Your tabs come back." }) });

let answer = normal;

async function boot() {
  answer = normal; // each test starts from the usual answers
  const home = mkdtempSync(join(tmpdir(), "friend-banner-home-"));
  const b = join(home, ".chrome-control-mcp");
  mkdirSync(join(b, "extension"), { recursive: true });
  writeFileSync(join(b, "token"), "t");
  const dir = mkdtempSync(join(tmpdir(), "friend-banner-"));
  calls.length = 0;
  app = await createApp({
    dataDir: dir,
    provider: new FakeProvider([]),
    config: { port: 0, roots: [] },
    pluginCatalogDir: join(dir, "no-catalog"),
    quick: {
      home,
      bundled: FAKE,
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return answer(args[args.length - 1] ?? "");
      },
    },
  });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const get = (cookie: string | null) => fetch(base() + "/api/plugins/chrome/banner", { headers: cookie ? { cookie } : {} });
const act = (cookie: string, what: "hide" | "restart", body: unknown) => fetch(base() + `/api/plugins/chrome/banner/${what}`, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify(body) });

afterEach(async () => {
  await app?.stop();
});

describe("the debugging banner of Chrome control", () => {
  it("is for the signed-in owner only", async () => {
    await boot();
    expect((await get(null)).status).toBe(401);
  });

  it("says whether the Chrome that is open has the flag, and how many shortcuts do", async () => {
    const cookie = await boot();
    const res = await get(cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supported: true, platform: "win32", running: true, hidden: false, shortcuts: { withFlag: 0, total: 8 } });
    expect(calls.at(-1)!.slice(1)).toEqual([FAKE, "flag-status"]);
  });

  it("answers plainly when the program's reply cannot be read", async () => {
    const cookie = await boot();
    answer = () => ({ code: 1, stdout: "garbage" });
    const body = (await (await get(cookie)).json()) as { supported: boolean; error?: string };
    expect(body.supported).toBe(true);
    expect(body.error).toMatch(/could not read/i);
    answer = (cmd) => ({ code: 0, stdout: cmd === "flag-status" ? JSON.stringify(STATUS) : "{}" });
  });

  it("adds the flag to the shortcuts only with the PIN", async () => {
    const cookie = await boot();
    expect((await act(cookie, "hide", {})).status).toBe(400);
    expect((await act(cookie, "hide", { pin: "000000" })).status).toBe(403);
    expect(calls).toEqual([]);
    const res = await act(cookie, "hide", { pin: owner.pin });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, patched: 3, failed: 1, message: expect.stringMatching(/3 shortcuts?/i) });
    expect(calls.at(-1)!.slice(1)).toEqual([FAKE, "flag"]);
  });

  it("restarts Chrome only with the PIN, and passes on what happened", async () => {
    const cookie = await boot();
    expect((await act(cookie, "restart", { pin: "000000" })).status).toBe(403);
    expect(calls).toEqual([]);
    const res = await act(cookie, "restart", { pin: owner.pin });
    expect(await res.json()).toEqual({ ok: true, message: "Chrome was restarted with the banner hidden. Your tabs come back." });
    expect(calls.at(-1)!.slice(1)).toEqual([FAKE, "chrome-restart"]);
  });

  it("says so when Chrome would not close", async () => {
    const cookie = await boot();
    answer = () => ({ code: 0, stdout: JSON.stringify({ ok: false, message: "Chrome did not close (it may be asking you to save something). Close it yourself, then press Start." }) });
    const res = await act(cookie, "restart", { pin: owner.pin });
    expect(await res.json()).toMatchObject({ ok: false, message: expect.stringMatching(/did not close/) });
  });

  it("reads the shortcut result as not working when no shortcut could be changed", async () => {
    const cookie = await boot();
    answer = () => ({ code: 0, stdout: JSON.stringify({ ok: false, counts: { patched: 0, already: 0, failed: 2, withFlag: 0, total: 2 } }) });
    const res = await act(cookie, "hide", { pin: owner.pin });
    expect(await res.json()).toMatchObject({ ok: false, failed: 2 });
  });
});

describe("ChromePlugin without its own copy of Chrome control", () => {
  it("says the banner cannot be managed from here", async () => {
    const plugin = new ChromePlugin({ hub: {} as McpHub, run: async () => ({ code: 0, stdout: "" }), bundled: null });
    expect(await plugin.bannerStatus()).toEqual({ supported: false });
    expect(await plugin.hideBanner()).toMatchObject({ ok: false });
    expect(await plugin.restartChrome()).toMatchObject({ ok: false });
  });
});
