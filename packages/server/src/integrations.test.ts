import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { DEFAULT_CHANNELS, loadConfig, sanitizeChannels } from "./config";
import { FakeProvider } from "./provider/fake";
import { changeIntegration, integrationSummary, integrationViews } from "./integrations";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const TOKEN = "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1";
const hubStatus = (over: Partial<ReturnType<typeof stat>["telegram"]> = {}) => ({ status: () => stat(over) });
const stat = (over: Record<string, unknown> = {}) => ({
  telegram: { enabled: true, tokenSet: true, linked: false, state: "online" as "off" | "connecting" | "online" | "error", detail: "", bot: "friend_bot", ...over },
  twilio: { enabled: true, tokenSet: true, ownerSet: true, sms: true, whatsapp: true, webhook: "https://friend.example.com/api/channels/twilio" },
});

const config = (mutate: (c: ReturnType<typeof loadConfig>) => void = () => {}) => {
  const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-integr-")));
  mutate(c);
  return c;
};

describe("what each integration says about itself", () => {
  it("starts not installed, with its steps and no detail", () => {
    const [tg, tw] = integrationViews(config(), hubStatus());
    expect(tg).toMatchObject({ id: "telegram", installed: false, state: "not-installed", enabled: false });
    expect(tw).toMatchObject({ id: "twilio", installed: false, state: "not-installed" });
    expect(tg!.steps).toHaveLength(4);
    expect(tw!.steps).toHaveLength(5);
  });

  it("Telegram: needs a token, then switching on, then connects and asks to be linked", () => {
    const c = config((x) => (x.channels.telegram.installed = true));
    expect(integrationViews(c, hubStatus())[0]).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/bot token/) });
    c.channels.telegram.botToken = TOKEN;
    expect(integrationViews(c, hubStatus())[0]).toMatchObject({ state: "off" });
    c.channels.telegram.enabled = true;
    expect(integrationViews(c, hubStatus({ state: "connecting" }))[0]).toMatchObject({ state: "connecting" });
    expect(integrationViews(c, hubStatus({ state: "error", detail: "Unauthorized" }))[0]).toMatchObject({ state: "error", detail: "Unauthorized" });
    const online = integrationViews(c, hubStatus())[0]!;
    expect(online).toMatchObject({ state: "online", detail: expect.stringMatching(/@friend_bot.*Link your Telegram/) });
    c.channels.telegram.ownerChatId = 5;
    expect(integrationViews(c, hubStatus())[0]!.detail).toMatch(/Your Telegram is linked/);
    expect(online.steps.map((s) => s.done)).toEqual([true, true, true, false]);
  });

  it("Twilio: needs the account, a number, and a public address", () => {
    const c = config((x) => (x.channels.twilio.installed = true));
    const state = () => integrationViews(c, hubStatus())[1]!;
    expect(state()).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/account SID/) });
    c.channels.twilio.accountSid = "AC" + "a".repeat(30);
    c.channels.twilio.authToken = "t";
    expect(state().detail).toMatch(/Twilio number/);
    c.channels.twilio.smsFrom = "+14155550100";
    expect(state().state).toBe("off");
    c.channels.twilio.enabled = true;
    expect(state()).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/public address/) });
    c.publicUrl = "https://friend.example.com";
    expect(state()).toMatchObject({ state: "online", detail: expect.stringMatching(/api\/channels\/twilio/) });
  });

  it("never lists a secret, only whether it is set", () => {
    const c = config((x) => {
      x.channels.telegram = { installed: true, enabled: true, botToken: TOKEN, ownerChatId: 5 };
      x.channels.twilio = { installed: true, enabled: true, accountSid: "AC" + "a".repeat(30), authToken: "very-secret", smsFrom: "+14155550100", whatsappFrom: "", ownerNumber: "+919800000000" };
    });
    const text = JSON.stringify(integrationViews(c, hubStatus())) + integrationSummary(integrationViews(c, hubStatus()));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("very-secret");
    expect(integrationViews(c, hubStatus())[1]!.secrets).toEqual({ authToken: true });
  });

  it("gives the assistant one plain line", () => {
    const line = integrationSummary(integrationViews(config(), hubStatus()));
    expect(line).toMatch(/Telegram \(telegram\): not installed; WhatsApp and SMS \(Twilio\) \(twilio\): not installed/);
  });
});

describe("changing an integration", () => {
  it("installs, switches on only when it has what it needs, and removes with the tokens", () => {
    const ch = sanitizeChannels(DEFAULT_CHANNELS);
    expect(changeIntegration(ch, "telegram", { enabled: true })).toMatch(/not installed/);
    expect(changeIntegration(ch, "telegram", { install: true })).toBeNull();
    expect(changeIntegration(ch, "telegram", { enabled: true })).toMatch(/bot token first/);
    ch.telegram.botToken = TOKEN;
    ch.telegram.ownerChatId = 9;
    expect(changeIntegration(ch, "telegram", { enabled: true })).toBeNull();
    expect(ch.telegram.enabled).toBe(true);
    expect(changeIntegration(ch, "telegram", { remove: true })).toBeNull();
    expect(ch.telegram).toEqual({ installed: false, enabled: false, botToken: null, ownerChatId: null });
    expect(changeIntegration(ch, "twilio", { install: true })).toBeNull();
    expect(changeIntegration(ch, "twilio", { enabled: true })).toMatch(/account SID and auth token/);
  });

  it("counts what an earlier version set up as installed", () => {
    expect(sanitizeChannels({ telegram: { enabled: true, botToken: TOKEN } }).telegram.installed).toBe(true);
    expect(sanitizeChannels({ twilio: { accountSid: "AC" + "a".repeat(30) } }).twilio.installed).toBe(true);
    expect(sanitizeChannels({}).telegram.installed).toBe(false);
    expect(sanitizeChannels({ telegram: { installed: false, enabled: true, botToken: TOKEN } }).telegram.installed).toBe(false);
  });
});

describe("the plugins screen's routes", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });
  async function boot() {
    const dir = mkdtempSync(join(tmpdir(), "friend-intapi-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "no-catalog") });
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;
    const j = { "content-type": "application/json" };
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
    const list = async () => ((await (await api("/api/plugins")).json()) as { integrations: ReturnType<typeof integrationViews> }).integrations;
    return { dir, api, list, save: (settings: unknown) => api("/api/settings", { method: "PUT", body: JSON.stringify({ pin: owner.pin, settings }) }) };
  }

  it("lists Telegram, Twilio, Zerodha and Alexa next to the other plugins, not installed", async () => {
    const { list } = await boot();
    const l = await list();
    expect(l.map((v) => [v.id, v.installed, v.state])).toEqual([["telegram", false, "not-installed"], ["twilio", false, "not-installed"], ["zerodha", false, "not-installed"], ["alexa", false, "not-installed"], ["spotify", false, "not-installed"], ["soundcloud", false, "not-installed"], ["audius", false, "not-installed"]]);
  });

  it("installs with the PIN, is saved, and shows what to do next", async () => {
    const { api, list, dir } = await boot();
    const post = (body: unknown) => api("/api/plugins/install", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ id: "telegram", pin: "000000" })).status).toBe(403);
    expect((await list())[0]!.installed).toBe(false);
    expect((await post({ id: "telegram", pin: owner.pin })).status).toBe(200);
    const [tg] = await list();
    expect(tg).toMatchObject({ installed: true, state: "needs-setup", detail: expect.stringMatching(/bot token/) });
    expect(loadConfig(dir).channels.telegram.installed).toBe(true);
  });

  it("installs Zerodha with the PIN, saves it, and removing it forgets the key and secret", async () => {
    const { api, list, save, dir } = await boot();
    const post = (body: unknown) => api("/api/plugins/install", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ id: "zerodha", pin: "000000" })).status).toBe(403);
    expect((await post({ id: "zerodha", pin: owner.pin })).status).toBe(200);
    expect((await list()).find((v) => v.id === "zerodha")).toMatchObject({ installed: true, state: "needs-setup", detail: expect.stringMatching(/Kite API key and secret/) });
    expect(loadConfig(dir).brokers.zerodha.installed).toBe(true);
    expect((await save({ brokers: { zerodha: { apiKey: "abc123", apiSecret: "SECRET123" } } })).status).toBe(200);
    expect(JSON.stringify(await list())).not.toContain("SECRET123");
    expect((await api("/api/plugins/zerodha", { method: "DELETE" })).status).toBe(200);
    expect(loadConfig(dir).brokers.zerodha).toEqual({ installed: false, enabled: false, apiKey: "", apiSecret: null });
  });

  it("switches on only after the token is saved, and switching on asks for the PIN", async () => {
    const { api, list, save } = await boot();
    await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ id: "telegram", pin: owner.pin }) });
    const enable = (enabled: boolean, pin?: string) => api("/api/plugins/telegram/enabled", { method: "POST", body: JSON.stringify({ enabled, ...(pin ? { pin } : {}) }) });
    expect((await enable(true)).status).toBe(400); // no PIN
    const noToken = await enable(true, owner.pin);
    expect(noToken.status).toBe(400);
    expect(((await noToken.json()) as { error: string }).error).toMatch(/bot token first/);
    expect((await save({ channels: { telegram: { botToken: TOKEN } } })).status).toBe(200);
    expect((await enable(true, owner.pin)).status).toBe(200);
    expect((await list())[0]).toMatchObject({ enabled: true });
    expect((await enable(false)).status).toBe(200); // off needs no PIN
    expect((await list())[0]).toMatchObject({ enabled: false, state: "off" });
  });

  it("removes an integration and forgets its token", async () => {
    const { api, list, save, dir } = await boot();
    await save({ channels: { telegram: { enabled: true, botToken: TOKEN } } });
    expect((await list())[0]!.installed).toBe(true); // configuring it counts as installing it
    expect((await api("/api/plugins/telegram", { method: "DELETE" })).status).toBe(200);
    expect((await list())[0]).toMatchObject({ installed: false, enabled: false, secrets: { botToken: false } });
    expect(loadConfig(dir).channels.telegram).toMatchObject({ installed: false, botToken: null });
  });

  it("never sends a secret to the screen", async () => {
    const { api, save } = await boot();
    await save({ channels: { telegram: { enabled: true, botToken: TOKEN }, twilio: { accountSid: "AC" + "a".repeat(30), authToken: "very-secret" } } });
    const text = await (await api("/api/plugins")).text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("very-secret");
  });
});
