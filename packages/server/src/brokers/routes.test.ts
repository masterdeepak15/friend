import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";
import { FakeKite } from "./testing/fakeKite";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(setup = true, catalog?: string) {
  const dir = mkdtempSync(join(tmpdir(), "friend-brokerapi-"));
  const kite = new FakeKite();
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: catalog ?? join(dir, "no-catalog"), brokerFetch: kite.fetch, brokerTickMs: 3_600_000 });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
  const anon = (path: string) => fetch(base + path);
  const json = async (path: string, init?: RequestInit) => (await api(path, init)).json() as Promise<Record<string, any>>;
  if (setup) {
    await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ id: "zerodha", pin: owner.pin }) });
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ pin: owner.pin, settings: { brokers: { zerodha: { apiKey: "KEY", apiSecret: "SECRET" } } } }) });
    await api("/api/plugins/zerodha/enabled", { method: "POST", body: JSON.stringify({ enabled: true, pin: owner.pin }) });
  }
  const stateFromLink = async () => {
    const { url } = (await json("/api/brokers/zerodha/login-link", { method: "POST", body: "{}" })) as { url: string };
    return new URL(url).searchParams.get("redirect_params")!.replace("state=", "");
  };
  const callback = (state: string | null, token = kite.issueRequestToken()) => anon(`/api/brokers/zerodha/callback?request_token=${token}&status=success${state ? `&state=${state}` : ""}`);
  return { dir, kite, api, anon, json, stateFromLink, callback };
}

describe("the login return", () => {
  it("logs in with a valid state, and the status then says so", async () => {
    const t = await boot();
    expect(((await t.json("/api/brokers")).zerodha as { loggedIn: boolean }).loggedIn).toBe(false);
    const res = await t.callback(await t.stateFromLink());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toMatch(/Logged in\. You can close this tab/);
    expect(((await t.json("/api/brokers")).zerodha as { loggedIn: boolean }).loggedIn).toBe(true);
  });

  it("answers a replay, a missing state and a made-up state with the same plain failure and stores nothing", async () => {
    const t = await boot();
    const state = await t.stateFromLink();
    expect((await (await t.callback(state)).text())).toMatch(/Logged in/);
    for (const s of [state, null, "0".repeat(48)]) {
      const res = await t.callback(s);
      expect(res.status).toBe(200);
      expect(await res.text()).toMatch(/That did not work\. Start again from Friend\./);
    }
    // after a logout-like reset nothing is left over from the failures
    const t2 = await boot();
    const bad = await t2.callback("0".repeat(48));
    expect(await bad.text()).toMatch(/did not work/);
    expect(((await t2.json("/api/brokers")).zerodha as { loggedIn: boolean }).loggedIn).toBe(false);
  });

  it("allows 20 returns a minute from one address, then says 429", async () => {
    const t = await boot();
    for (let i = 0; i < 20; i++) expect((await t.callback("0".repeat(48))).status).toBe(200);
    expect((await t.callback("0".repeat(48))).status).toBe(429);
  });
});

describe("the owner's routes", () => {
  it("need the owner's session", async () => {
    const t = await boot();
    expect((await t.anon("/api/brokers")).status).toBe(401);
    expect((await t.anon("/api/brokers/schedules")).status).toBe(401);
  });

  it("never carry the secret or the access token", async () => {
    const t = await boot();
    await t.callback(await t.stateFromLink());
    const all = JSON.stringify(await t.json("/api/brokers")) + JSON.stringify(await t.json("/api/plugins")) + JSON.stringify(await t.json("/api/settings"));
    expect(all).not.toContain("SECRET");
    expect(all).not.toContain("ACCESS-1");
  });

  it("refuse a login link before the plugin is set up", async () => {
    const t = await boot(false);
    const res = await t.api("/api/brokers/zerodha/login-link", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });
});

describe("schedules", () => {
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({ name: "Morning", kind: "morning", time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram", pin: owner.pin, ...over });

  it("are added with the PIN, listed, and removed", async () => {
    const t = await boot();
    const add = (b: string) => t.api("/api/brokers/schedules", { method: "POST", body: b });
    expect((await add(body({ pin: undefined }))).status).toBe(400);
    expect((await add(body({ pin: "000000" }))).status).toBe(403);
    expect((await add(body({ time: "25:00" }))).status).toBe(400);
    expect((await add(body({ days: [0, 9] }))).status).toBe(400);
    expect((await add(body({ channel: "pigeon" }))).status).toBe(400);
    const ok = await add(body());
    expect(ok.status).toBe(200);
    const made = (await ok.json()) as { id: number };
    const list = (await t.json("/api/brokers/schedules")) as { schedules: { id: number; time: string }[] };
    expect(list.schedules).toHaveLength(1);
    expect(list.schedules[0]).toMatchObject({ id: made.id, time: "09:30" });
    expect((await t.api(`/api/brokers/schedules/${made.id}`, { method: "DELETE" })).status).toBe(200);
    expect(((await t.json("/api/brokers/schedules")) as { schedules: unknown[] }).schedules).toHaveLength(0);
    expect((await t.api("/api/brokers/schedules/99999", { method: "DELETE" })).status).toBe(404);
  });
});

describe("the portfolio skill", () => {
  it("is installed with Zerodha and removed with it", async () => {
    const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../plugins");
    const t = await boot(false, catalog);
    const installed = async () => ((await t.json("/api/plugins")).installed as { id: string }[]).map((p) => p.id);
    expect(await installed()).not.toContain("portfolio-assistant");
    await t.api("/api/plugins/install", { method: "POST", body: JSON.stringify({ id: "zerodha", pin: owner.pin }) });
    expect(await installed()).toContain("portfolio-assistant");
    await t.api("/api/plugins/zerodha", { method: "DELETE" });
    expect(await installed()).not.toContain("portfolio-assistant");
  });
});

describe("a report now", () => {
  it("returns the report text for a logged-in account, and says the login ended otherwise", async () => {
    const t = await boot();
    const before = await t.api("/api/brokers/run", { method: "POST", body: JSON.stringify({}) });
    expect(before.status).toBe(409);
    expect(await before.json()).toMatchObject({ sessionExpired: true });
    await t.callback(await t.stateFromLink());
    const ok = await t.api("/api/brokers/run", { method: "POST", body: JSON.stringify({ kind: "close" }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { text: string }).text).toContain("Portfolio: ₹");
  });
});
