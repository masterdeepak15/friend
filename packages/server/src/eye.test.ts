import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig, sanitizeEye, type Config } from "./config";
import { Eye } from "./eye";
import { FakeProvider } from "./provider/fake";
import { applySettings, refuseForAgent } from "./settings";

describe("the eye setting", () => {
  it("is off by default, and the time-out is kept between 0 and 24 hours", () => {
    expect(sanitizeEye(undefined)).toEqual({ on: false, autoOffMinutes: 120 });
    expect(sanitizeEye({ on: true, autoOffMinutes: 30 })).toEqual({ on: true, autoOffMinutes: 30 });
    expect(sanitizeEye({ on: "yes" as never, autoOffMinutes: -5 })).toEqual({ on: false, autoOffMinutes: 0 });
    expect(sanitizeEye({ autoOffMinutes: 99999 }).autoOffMinutes).toBe(1440);
    expect(sanitizeEye({ autoOffMinutes: 12.7 }).autoOffMinutes).toBe(13);
  });

  it("is read from the saved file", () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), "friend-eye-"))).eye).toEqual({ on: false, autoOffMinutes: 120 });
  });

  it("can be changed by the settings patch, but never by the assistant", () => {
    const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-eye-")));
    expect(applySettings(c, { eye: { on: true, autoOffMinutes: 45 } }).changed).toEqual(expect.arrayContaining(["eye.on", "eye.autoOffMinutes"]));
    expect(c.eye).toEqual({ on: true, autoOffMinutes: 45 });
    expect(() => refuseForAgent({ eye: { on: true } })).toThrow(/only be changed by the owner/);
    expect(() => refuseForAgent({ eye: { autoOffMinutes: 0 } })).toThrow();
  });
});

function rig(start: Partial<Config["eye"]> = {}) {
  const config = { eye: { on: false, autoOffMinutes: 120, ...start } } as Config;
  const log: { kind: string; detail: unknown }[] = [];
  let now = 1_000_000;
  const persisted: boolean[] = [];
  const eye = new Eye({
    config: () => config,
    clock: () => now,
    persist: (on) => {
      config.eye.on = on;
      persisted.push(on);
    },
    audit: { log: ((_who: string, kind: string, detail: unknown) => void log.push({ kind, detail })) as never },
  });
  return { eye, config, log, persisted, advance: (ms: number) => (now += ms) };
}

describe("Eye", () => {
  it("knows when it is on, and writes an entry each time it is switched", () => {
    const r = rig();
    expect(r.eye.isOn()).toBe(false);
    r.config.eye.on = true;
    r.eye.sync();
    expect(r.eye.isOn()).toBe(true);
    expect(r.log.map((l) => l.kind)).toEqual(["eye.on"]);
    r.config.eye.on = false;
    r.eye.sync();
    expect(r.log.map((l) => l.kind)).toEqual(["eye.on", "eye.off"]);
  });

  it("switches itself off after the minutes the owner chose", () => {
    const r = rig({ autoOffMinutes: 30 });
    r.config.eye.on = true;
    r.eye.sync();
    r.advance(29 * 60_000);
    r.eye.sync();
    expect(r.eye.isOn()).toBe(true);
    r.advance(2 * 60_000);
    r.eye.sync();
    expect(r.eye.isOn()).toBe(false);
    expect(r.persisted).toEqual([false]);
    expect(r.log.at(-1)).toMatchObject({ kind: "eye.off", detail: { reason: "timeout" } });
  });

  it("never switches itself off when the minutes are 0", () => {
    const r = rig({ autoOffMinutes: 0 });
    r.config.eye.on = true;
    r.eye.sync();
    r.advance(48 * 3600_000);
    r.eye.sync();
    expect(r.eye.isOn()).toBe(true);
  });

  it("is off again after a restart, even if the file said on", () => {
    const r = rig({ on: true });
    expect(r.eye.isOn()).toBe(false);
    expect(r.persisted).toEqual([false]);
    expect(r.log.at(-1)).toMatchObject({ kind: "eye.off", detail: { reason: "restart" } });
  });

  it("switchOff does nothing when it is already off", () => {
    const r = rig();
    r.eye.switchOff("sign-out");
    expect(r.persisted).toEqual([]);
    expect(r.log).toEqual([]);
  });
});

describe("the eye on the settings route and sign-out", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => {
    await app?.stop();
  });
  const j = { "content-type": "application/json" };

  async function boot(config: object = {}) {
    const dir = mkdtempSync(join(tmpdir(), "friend-eye-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], ...config } });
    const port = (await app.start()).port;
    const base = `http://127.0.0.1:${port}`;
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const put = (settings: object, pin?: string) => fetch(`${base}/api/settings`, { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });
    const get = async () => (await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json()) as { eye: Config["eye"] };
    return { base, cookie, put, get };
  }

  it("needs the PIN to switch on, but not to switch off", async () => {
    const t = await boot();
    expect((await t.put({ eye: { on: true } })).ok).toBe(false);
    expect((await t.get()).eye.on).toBe(false);
    expect((await t.put({ eye: { on: true } }, "123456")).ok).toBe(true);
    expect((await t.get()).eye.on).toBe(true);
    expect((await t.put({ eye: { on: false } })).ok).toBe(true);
    expect((await t.get()).eye.on).toBe(false);
  });

  it("changing the minutes needs the PIN, even while switching off", async () => {
    const t = await boot();
    expect((await t.put({ eye: { on: false, autoOffMinutes: 5 } })).ok).toBe(false);
    expect((await t.put({ eye: { autoOffMinutes: 5 } }, "123456")).ok).toBe(true);
  });

  it("starts switched off even when the saved file says on", async () => {
    const t = await boot({ eye: { on: true, autoOffMinutes: 120 } });
    expect((await t.get()).eye.on).toBe(false);
  });

  it("switches off when the owner signs out", async () => {
    const t = await boot();
    await t.put({ eye: { on: true } }, "123456");
    expect((await t.get()).eye.on).toBe(true);
    await fetch(`${t.base}/api/logout`, { method: "POST", headers: { cookie: t.cookie } });
    const login = await fetch(`${t.base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const view = (await (await fetch(`${t.base}/api/settings`, { headers: { cookie } })).json()) as { eye: Config["eye"] };
    expect(view.eye.on).toBe(false);
  });
});
