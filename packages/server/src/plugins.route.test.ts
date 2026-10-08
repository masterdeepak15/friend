import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

async function boot() {
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-plugroute-")),
    provider: new FakeProvider([]),
    config: { port: 0, roots: [] },
    pluginCatalogDir: catalog,
  });
  port = (await app.start()).port;
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const api = (cookie: string | null, method: string, path: string, body?: unknown) =>
  fetch(base() + "/api/plugins" + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

afterEach(async () => {
  await app.stop();
});

describe("plugin routes", () => {
  it("need a logged-in session", async () => {
    await boot();
    for (const [m, p, b] of [["GET", "", undefined], ["POST", "/install", { id: "rubber-duck", pin: owner.pin }], ["POST", "/rubber-duck/enabled", { enabled: false }], ["DELETE", "/rubber-duck", undefined]] as const) {
      expect((await api(null, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  it("lists the catalog with what is installed", async () => {
    const cookie = await boot();
    const before = (await (await api(cookie, "GET", "")).json()) as { installed: unknown[]; catalog: { id: string; installed: boolean; tools: number; skills: number }[] };
    expect(before.installed).toEqual([]);
    expect(before.catalog.map((c) => c.id).sort()).toEqual(["rubber-duck", "standup-writer", "unit-converter"]);
    expect(before.catalog.every((c) => !c.installed)).toBe(true);
    expect(before.catalog.find((c) => c.id === "unit-converter")).toMatchObject({ tools: 1, skills: 0, name: "Unit converter" });
  });

  it("installs from the catalog only with the right PIN, and the agent gets the plugin at once", async () => {
    const cookie = await boot();
    expect((await api(cookie, "POST", "/install", { id: "standup-writer" })).status).toBe(400);
    expect((await api(cookie, "POST", "/install", { id: "standup-writer", pin: "000000" })).status).toBe(403);
    expect(app.plugins.list()).toEqual([]);
    const ok = await api(cookie, "POST", "/install", { id: "standup-writer", pin: owner.pin });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: "standup-writer", upgraded: false });
    expect(app.plugins.skills().map((s) => s.name)).toEqual(["standup"]);
    const after = (await (await api(cookie, "GET", "")).json()) as { installed: { id: string; enabled: boolean }[]; catalog: { id: string; installed: boolean }[] };
    expect(after.installed).toMatchObject([{ id: "standup-writer", enabled: true }]);
    expect(after.catalog.find((c) => c.id === "standup-writer")!.installed).toBe(true);
    expect(JSON.stringify(app.db.prepare("select kind from audit_log").all())).toContain("plugin.installed");
  });

  it("will not install anything that is not in the catalog, and ignores path tricks", async () => {
    const cookie = await boot();
    expect((await api(cookie, "POST", "/install", { id: "no-such-plugin", pin: owner.pin })).status).toBe(404);
    for (const id of ["../server", "..\\x", "/etc", "a/b", "C:\\Windows", ""]) {
      expect((await api(cookie, "POST", "/install", { id, pin: owner.pin })).status, id).toBe(400);
    }
    expect(app.plugins.list()).toEqual([]);
  });

  it("switching on needs the PIN; switching off and removing do not", async () => {
    const cookie = await boot();
    await api(cookie, "POST", "/install", { id: "rubber-duck", pin: owner.pin });
    expect((await api(cookie, "POST", "/rubber-duck/enabled", { enabled: false })).status).toBe(200);
    expect(app.plugins.skills()).toEqual([]);
    expect((await api(cookie, "POST", "/rubber-duck/enabled", { enabled: true })).status).toBe(400);
    expect((await api(cookie, "POST", "/rubber-duck/enabled", { enabled: true, pin: "000000" })).status).toBe(403);
    expect((await api(cookie, "POST", "/rubber-duck/enabled", { enabled: true, pin: owner.pin })).status).toBe(200);
    expect(app.plugins.skills()).toHaveLength(1);
    expect((await api(cookie, "DELETE", "/rubber-duck")).status).toBe(200);
    expect(app.plugins.list()).toEqual([]);
    expect((await api(cookie, "DELETE", "/rubber-duck")).status).toBe(404);
    expect((await api(cookie, "POST", "/ghost/enabled", { enabled: false })).status).toBe(404);
  });

  it("are rate limited", async () => {
    const cookie = await boot();
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await api(cookie, "GET", "")).status);
    expect(codes).toContain(429);
  });
});

describe("plugin reload route", () => {
  it("needs a session, and reads the plugins again for the owner", async () => {
    const cookie = await boot();
    expect((await api(null, "POST", "/reload", {})).status).toBe(401);
    const res = await api(cookie, "POST", "/reload", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ installed: [], catalog: expect.any(Array) });
    const rows = app.db.prepare("select kind from audit_log where kind = 'plugin.reloaded'").all();
    expect(rows).toHaveLength(1);
  });
});
