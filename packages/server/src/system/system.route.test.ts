import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp, type AppOptions } from "../app";
import { loadConfig } from "../config";
import { FakeProvider } from "../provider/fake";
import type { AutostartDeps } from "./autostart";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];

/** A computer that remembers whether the login entry was written. */
function fakeComputer() {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  let enabled = false;
  const deps: AutostartDeps = {
    platform: "linux",
    home: "/home/me",
    dataDir: "/home/me/.friend",
    uid: 1000,
    path: "/usr/bin",
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? null,
    write: (p, t) => void files.set(p, t),
    remove: (p) => void files.delete(p),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes("enable")) enabled = true;
      if (args.includes("disable")) enabled = false;
      if (args.includes("is-enabled")) return { code: enabled ? 0 : 1, stdout: enabled ? "enabled\n" : "disabled\n" };
      return { code: 0, stdout: "" };
    },
  };
  return { deps, files, calls };
}

async function boot(system: AppOptions["system"] = {}, config: object = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-system-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], ...config }, pluginCatalogDir: join(dir, "none"), system });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const get = (cookie: string | null, path = "") => fetch(base() + "/api/system" + path, { headers: cookie ? { cookie } : {} });
const post = (cookie: string, path: string, body: unknown = {}) => fetch(base() + "/api/system" + path, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify(body) });
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
});

const SELF = { node: "/usr/bin/node", script: "/usr/lib/friend/friend.mjs" };

describe("starting by itself and updating, from the settings screen", () => {
  it("is for the signed-in owner only", async () => {
    await boot();
    expect((await get(null)).status).toBe(401);
    expect((await fetch(base() + "/api/system/autostart", { method: "POST", headers: j, body: "{}" })).status).toBe(401);
  });

  it("says which version this is, whether a newer one is known, and whether Friend starts by itself", async () => {
    const pc = fakeComputer();
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps, current: () => "0.1.44", latest: async () => "0.1.45", canApply: () => true });
    const body = (await (await get(cookie)).json()) as { version: string; update: { latest: string | null; available: boolean; canApply: boolean }; autostart: { supported: boolean; enabled: boolean }; auto: boolean };
    expect(body.version).toBe("0.1.44");
    expect(body.update).toMatchObject({ latest: null, available: false, canApply: true });
    expect(body.autostart).toMatchObject({ supported: true, enabled: false });
    expect(body.auto).toBe(true);
  });

  it("looks for a newer version when asked, and tells the screen", async () => {
    const pc = fakeComputer();
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps, current: () => "0.1.44", latest: async () => "0.1.45", canApply: () => false });
    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    const res = await post(cookie, "/update/check");
    expect(await res.json()).toMatchObject({ latest: "0.1.45", available: true });
    await until(() => msgs.some((m) => m.type === "alert" && /0\.1\.45 is available/.test(m.text)));
    expect(msgs.some((m) => m.type === "alert" && /friend upgrade/.test(m.text))).toBe(true);
  });

  it("updates now only with the PIN", async () => {
    const pc = fakeComputer();
    const apply = vi.fn(async () => true);
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps, current: () => "0.1.44", latest: async () => "0.1.45", canApply: () => true, apply }, { updates: { auto: false } });
    expect((await post(cookie, "/update/apply", {})).status).toBe(400);
    expect((await post(cookie, "/update/apply", { pin: "000000" })).status).toBe(403);
    expect(apply).not.toHaveBeenCalled();
    const res = await post(cookie, "/update/apply", { pin: owner.pin });
    expect(await res.json()).toMatchObject({ ok: true });
    expect(apply).toHaveBeenCalledWith("0.1.45");
  });

  it("says when there is nothing newer", async () => {
    const pc = fakeComputer();
    const apply = vi.fn(async () => true);
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps, current: () => "0.1.45", latest: async () => "0.1.45", canApply: () => true, apply });
    const res = await post(cookie, "/update/apply", { pin: owner.pin });
    expect(await res.json()).toMatchObject({ ok: false, message: expect.stringMatching(/up to date/i) });
    expect(apply).not.toHaveBeenCalled();
  });

  it("switches starting by itself on and off, only with the PIN", async () => {
    const pc = fakeComputer();
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps });
    expect((await post(cookie, "/autostart", { enabled: true })).status).toBe(400);
    expect((await post(cookie, "/autostart", { enabled: true, pin: "000000" })).status).toBe(403);
    expect(pc.files.size).toBe(0);
    const on = (await (await post(cookie, "/autostart", { enabled: true, pin: owner.pin })).json()) as { ok: boolean; status: { enabled: boolean } };
    expect(on).toMatchObject({ ok: true, status: { enabled: true } });
    expect(pc.files.has("/home/me/.config/systemd/user/friend.service")).toBe(true);
    const off = (await (await post(cookie, "/autostart", { enabled: false, pin: owner.pin })).json()) as { ok: boolean; status: { enabled: boolean } };
    expect(off).toMatchObject({ ok: true, status: { enabled: false } });
    expect(pc.files.size).toBe(0);
  });

  it("refuses a request that is not a yes or no", async () => {
    const pc = fakeComputer();
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps });
    expect((await post(cookie, "/autostart", { enabled: "yes", pin: owner.pin })).status).toBe(400);
  });
});

describe("looking for updates when Friend starts", () => {
  it("looks a little after it starts, and updates by itself when that is on and nothing is going on", async () => {
    const pc = fakeComputer();
    const apply = vi.fn(async () => true);
    await boot({ self: SELF, autostartDeps: pc.deps, checkForUpdates: true, times: { firstMs: 30 }, current: () => "0.1.44", latest: async () => "0.1.45", canApply: () => true, apply });
    await until(() => apply.mock.calls.length > 0);
    expect(apply).toHaveBeenCalledWith("0.1.45");
  });

  it("only tells the owner when automatic updates are switched off", async () => {
    const pc = fakeComputer();
    const apply = vi.fn(async () => true);
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps, checkForUpdates: true, times: { firstMs: 30 }, current: () => "0.1.44", latest: async () => "0.1.45", canApply: () => true, apply }, { updates: { auto: false } });
    let latest: string | null = null;
    for (let i = 0; i < 100 && latest === null; i++) {
      latest = ((await (await get(cookie)).json()) as { update: { latest: string | null } }).update.latest;
      if (latest === null) await new Promise((r) => setTimeout(r, 20));
    }
    expect(latest).toBe("0.1.45"); // it looked and found it
    await new Promise((r) => setTimeout(r, 150));
    expect(apply).not.toHaveBeenCalled(); // but, with automatic updates off, left the choice to the owner
  });

  it("does not look at all unless the program that starts Friend asks for it", async () => {
    const pc = fakeComputer();
    const latest = vi.fn(async () => "0.1.45");
    await boot({ self: SELF, autostartDeps: pc.deps, times: { firstMs: 10 }, current: () => "0.1.44", latest });
    await new Promise((r) => setTimeout(r, 120));
    expect(latest).not.toHaveBeenCalled();
  });

  it("a change in Settings takes effect: switching automatic updates off stops the next one", async () => {
    const pc = fakeComputer();
    const apply = vi.fn(async () => true);
    const cookie = await boot({ self: SELF, autostartDeps: pc.deps, current: () => "0.1.44", latest: async () => "0.1.45", canApply: () => true, apply });
    const put = await fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: owner.pin, settings: { updates: { auto: false } } }) });
    expect(put.status).toBe(200);
    expect(loadConfig(dir).updates.auto).toBe(false);
    await post(cookie, "/update/check");
    expect(apply).not.toHaveBeenCalled();
  });
});
