import { NO_PC_PERMISSIONS } from "@friend/protocol";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { Audit } from "../audit";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { changePcs, integrationViews } from "../integrations";
import { FakeProvider } from "../provider/fake";
import { PcHub, type PcSocket } from "./hub";
import { PcStore } from "./store";
import { PcTools } from "./tools";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const card = (c: Config, counts?: { total: number; online: number }) => integrationViews(c, { status: () => ({}) as never }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts ? { counts: () => counts } : undefined).find((v) => v.id === "windows-pcs")!;
const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-pcplugin-")));

describe("Windows PCs as a plugin on the plugins screen", () => {
  it("is offered as an integration that starts not installed, with a description of what it does", () => {
    const v = card(fresh());
    expect(v).toMatchObject({ id: "windows-pcs", name: "Windows PCs", installed: false, enabled: false, state: "not-installed" });
    expect(v.description).toMatch(/Claude Code/);
    expect(v.description).toMatch(/nothing of Friend is installed/i);
  });

  it("goes through install, switching on and removing like the others, and cannot be switched on before it is installed", () => {
    const c = fresh();
    expect(changePcs(c.pcs, { enabled: true })).toMatch(/not installed yet/);
    expect(changePcs(c.pcs, { install: true })).toBeNull();
    expect(card(c)).toMatchObject({ installed: true, enabled: false, state: "off" });
    expect(changePcs(c.pcs, { enabled: true })).toBeNull();
    expect(card(c)).toMatchObject({ enabled: true, state: "needs-setup", detail: expect.stringMatching(/Add a PC/) });
    expect(changePcs(c.pcs, { remove: true })).toBeNull();
    expect(c.pcs).toEqual({ installed: false, enabled: false });
  });

  it("says how many PCs there are and how many are online", () => {
    const c = fresh();
    changePcs(c.pcs, { install: true });
    changePcs(c.pcs, { enabled: true });
    expect(card(c, { total: 3, online: 2 })).toMatchObject({ state: "online", detail: expect.stringContaining("2 of 3 PCs online") });
    expect(card(c, { total: 1, online: 0 })).toMatchObject({ state: "connecting", detail: expect.stringContaining("none online") });
    expect(card(c, { total: 2, online: 2 }).steps.map((s) => s.done)).toEqual([true, true, true]);
  });

  it("is installed and switched on from the plugins routes with the PIN, and the PC list is closed until then", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-pcplugin-app-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([[{ type: "done" }]] as never), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;
    const j = { "content-type": "application/json" };
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
    const plugin = async () => ((await (await api("/api/plugins")).json()) as { integrations: { id: string; installed: boolean; enabled: boolean; state: string }[] }).integrations.find((i) => i.id === "windows-pcs")!;

    expect(await plugin()).toMatchObject({ installed: false, state: "not-installed" });
    expect((await api("/api/pc")).status).toBe(409);
    expect((await api("/api/pc", { method: "POST", body: JSON.stringify({ name: "Office", pin: owner.pin }) })).status).toBe(409);

    expect((await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ id: "windows-pcs", pin: owner.pin }) })).status).toBe(200);
    expect(await plugin()).toMatchObject({ installed: true, enabled: false, state: "off" });
    expect((await api("/api/pc")).status).toBe(200);
    expect((await api("/api/plugins/windows-pcs/enabled", { method: "POST", body: JSON.stringify({ enabled: true, pin: owner.pin }) })).status).toBe(200);
    expect(await plugin()).toMatchObject({ enabled: true, state: "needs-setup" });

    // what the owner chose is still there after a restart of the settings
    expect(loadConfig(dir).pcs).toEqual({ installed: true, enabled: true });
    expect((await api("/api/plugins/windows-pcs", { method: "DELETE" })).status).toBe(200);
    expect(await plugin()).toMatchObject({ installed: false });
    expect((await api("/api/pc")).status).toBe(409);
  });
});

describe("the assistant's PC tools when the plugin is off", () => {
  class Quiet extends EventEmitter implements PcSocket {
    send(): void {}
    close(): void {}
  }
  it("say so in a sentence and touch nothing", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-pcplugin-tools-")));
    const store = new PcStore(db);
    const hub = new PcHub({ store });
    const made = store.create({ name: "Office", permissions: { ...NO_PC_PERMISSIONS, shell: true } });
    if ("error" in made) throw new Error(made.error);
    hub.attach(made.pc.id, new Quiet());
    let on = false;
    const tools = new PcTools({ hub, store, audit: new Audit(db), extraPatterns: () => [], enabled: () => on });
    expect(tools.prepare("pc.shell", { command: "dir" })).toMatchObject({ error: expect.stringMatching(/not switched on/) });
    expect(tools.prepare("pc.list", {})).toMatchObject({ error: expect.stringMatching(/not switched on/) });
    on = true;
    expect(tools.prepare("pc.shell", { command: "dir" })).toMatchObject({ pcName: "Office" });
  });
});
