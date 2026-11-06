import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { Audit } from "./audit";
import { checkConfigFile, loadConfig, saveConfig, trackConfigHash } from "./config";
import { openDb } from "./db";
import { settingChanges } from "./settings";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

async function boot(over: { dir?: string; system?: object; updatesAuto?: boolean; script?: ConstructorParameters<typeof FakeProvider>[0] } = {}) {
  const dir = over.dir ?? mkdtempSync(join(tmpdir(), "friend-audit-gaps-"));
  app = await createApp({
    dataDir: dir,
    provider: new FakeProvider(over.script ?? []),
    config: { port: 0, roots: [], ...(over.updatesAuto ? { updates: { auto: true } } : {}) },
    pluginCatalogDir: join(dir, "none"),
    ...(over.system ? { system: over.system as never } : {}),
  });
  port = (await app.start()).port;
  if (!over.dir) await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return { dir, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const entries = (kind: string, dir?: string) => (dir ? new Audit(openDb(dir)) : new Audit(app!.db)).list(300).filter((r) => r.kind === kind).reverse();

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
});

describe("setting changes record what they were and what they became", () => {
  it("settingChanges gives key, from and to, and masks anything secret on both sides", () => {
    const before = { voice: { duckPercent: 25 }, web: { tavilyKey: "tvly-old-secret", provider: "duckduckgo" }, channels: { telegram: { botToken: "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1" } } };
    const after = { voice: { duckPercent: 40 }, web: { tavilyKey: "tvly-new-secret", provider: "tavily" }, channels: { telegram: { botToken: "999999999:AAEhBP0abcdefghijklmnopqrstuvwxyz2" } } };
    const out = settingChanges(before, after, ["voice.duckPercent", "web.tavilyKey", "web.provider", "channels.telegram.botToken"]);
    expect(out).toEqual([
      { setting: "voice.duckPercent", from: 25, to: 40 },
      { setting: "web.tavilyKey", from: "[redacted]", to: "[redacted]" },
      { setting: "web.provider", from: "duckduckgo", to: "tavily" },
      { setting: "channels.telegram.botToken", from: "[redacted]", to: "[redacted]" },
    ]);
  });

  it("a long value is cut", () => {
    const out = settingChanges({ office: { projects: [] } }, { office: { projects: [{ name: "x".repeat(2000) }] } }, ["office.projects"]);
    expect(JSON.stringify(out[0]!.to).length).toBeLessThan(700);
  });

  it("the settings.changed entry carries the changes, and no secret value anywhere in the log", async () => {
    const { cookie } = await boot();
    const res = await fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: owner.pin, settings: { voice: { duckPercent: 40 }, web: { tavilyKey: "tvly-test-key-12345" } } }) });
    expect(res.status).toBe(200);
    const [e] = entries("settings.changed");
    expect(e!.detail.changes).toEqual(expect.arrayContaining([{ setting: "voice.duckPercent", from: 25, to: 40 }, { setting: "web.tavilyKey", from: null, to: "[redacted]" }]));
    expect(JSON.stringify(new Audit(app!.db).list(300))).not.toContain("tvly-test-key-12345");
  });
});

describe("requests and the system", () => {
  it("a chat request is written with its text and where it came from", async () => {
    const { cookie } = await boot({ script: [[{ type: "text_delta", text: "Hi." }, { type: "done" }]] });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    await new Promise<void>((r, e) => (ws.on("open", () => r()), ws.on("error", e)));
    ws.send(JSON.stringify({ type: "chat.send", text: "good morning Maya" }));
    await until(() => entries("request").length > 0);
    expect(entries("request")[0]).toMatchObject({ actorKind: "owner", outcome: "started", detail: { text: "good morning Maya", source: "chat", trust: "owner" } });
  });

  it("start and stop are written with the version", async () => {
    const { dir } = await boot({ system: { current: () => "9.9.9" } });
    console.log(new Audit(app!.db).list(20).map((r) => r.kind).join(","));
    expect(entries("system.start")[0]).toMatchObject({ actorKind: "system", detail: { version: "9.9.9", port } });
    await app!.stop();
    app = undefined;
    expect(entries("system.stop", dir)[0]).toMatchObject({ detail: { version: "9.9.9" } });
  });

  it("an update is written with from and to", async () => {
    await boot({ updatesAuto: true, system: { checkForUpdates: true, current: () => "1.0.0", latest: async () => "1.1.0", canApply: () => true, apply: async () => true, times: { firstMs: 5, everyMs: 60_000, retryMs: 60_000 } } });
    await until(() => entries("system.update").length > 0);
    expect(entries("system.update")[0]).toMatchObject({ actorKind: "system", outcome: "started", detail: { from: "1.0.0", to: "1.1.0", auto: true } });
  });

  it("a failed login also records the browser it came from", async () => {
    await boot();
    await fetch(base() + "/api/login", { method: "POST", headers: { ...j, "user-agent": "evil-scanner/1.0" }, body: JSON.stringify({ password: "not the password" }) });
    const last = entries("http.request").filter((r) => r.target === "POST /api/login").at(-1)!;
    expect(last.detail.userAgent).toBe("evil-scanner/1.0");
  });
});

describe("the settings file changed behind Friend's back", () => {
  it("checkConfigFile starts from a baseline, stays quiet for Friend's own saves, and notices an edit by hand", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-cfg-hash-"));
    const cfg = loadConfig(dir);
    saveConfig(cfg);
    expect(checkConfigFile(dir)).toMatchObject({ state: "baseline" }); // no hash yet: the first look is the baseline
    trackConfigHash(true);
    try {
      cfg.ownerName = "Deepak";
      saveConfig(cfg);
      expect(checkConfigFile(dir)).toMatchObject({ state: "same" });
    } finally {
      trackConfigHash(false);
    }
    const file = join(dir, "config.json");
    writeFileSync(file, readFileSync(file, "utf8").replace("Deepak", "Mallory"));
    const changed = checkConfigFile(dir);
    expect(changed).toMatchObject({ state: "changed" });
    expect(changed.from).not.toBe(changed.to);
    expect(checkConfigFile(dir)).toMatchObject({ state: "same" }); // it is told once
  });

  it("a change made while Friend was stopped is written when it starts", async () => {
    const { dir } = await boot();
    await app!.stop();
    app = undefined;
    const file = join(dir, "config.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"ownerName": ""', '"ownerName": "Changed outside"'));
    await boot({ dir });
    expect(entries("config.external_change")[0]).toMatchObject({ actorKind: "system" });
  });
});
