import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { FakeProvider } from "../provider/fake";
import { refuseForAgent, settingsView } from "../settings";
import { ChannelHub } from "./hub";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const TOKEN = "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1";
const SID = "AC" + "b".repeat(30);
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(config: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-chroutes-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], ...config } });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...j, cookie, ...(init.headers as object) } });
  const save = (settings: unknown, pin: string = owner.pin) => api("/api/settings", { method: "PUT", body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });
  return { base, dir, api, save, cookie };
}

describe("setting channels up from the screen", () => {
  it("needs the PIN, keeps the tokens secret, and starts Telegram", async () => {
    const { save, api, dir } = await boot();
    expect((await save({ channels: { telegram: { enabled: true, botToken: TOKEN } } }, "")).status).toBe(400);
    const res = await save({ channels: { telegram: { enabled: true, botToken: TOKEN }, twilio: { enabled: true, accountSid: SID, authToken: "secret-auth", smsFrom: "+1 (415) 555-0100", ownerNumber: "+91 98000 00000" } } });
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("secret-auth");
    expect(JSON.parse(body).settings.channels).toEqual({
      telegram: { enabled: true, tokenSet: true, linked: false },
      twilio: { enabled: true, accountSid: SID, tokenSet: true, smsFrom: "+14155550100", whatsappFrom: "", ownerNumber: "+919800000000" },
    });
    // saved in the file, and the status route shows no secrets either
    expect(loadConfig(dir).channels.telegram.botToken).toBe(TOKEN);
    const status = await (await api("/api/channels")).text();
    expect(status).not.toContain(TOKEN);
    expect(status).not.toContain("secret-auth");
    expect(JSON.parse(status)).toMatchObject({ telegram: { enabled: true, tokenSet: true }, twilio: { tokenSet: true, sms: true, ownerSet: true }, unread: 0 });
  });

  it("refuses a token or number of the wrong shape", async () => {
    const { save } = await boot();
    for (const channels of [
      { telegram: { botToken: "not a token" } },
      { twilio: { accountSid: "XX123" } },
      { twilio: { ownerNumber: "call me maybe" } },
      { twilio: { surprise: true } },
    ]) expect((await save({ channels })).status).toBe(400);
  });

  it("leaves a saved token alone when the field is left empty", async () => {
    const { save, dir } = await boot();
    await save({ channels: { telegram: { enabled: true, botToken: TOKEN } } });
    await save({ channels: { telegram: { enabled: false, botToken: "" } } });
    expect(loadConfig(dir).channels.telegram).toMatchObject({ enabled: false, botToken: TOKEN });
  });

  it("cannot be done by the AI, even with the PIN", () => {
    expect(() => refuseForAgent({ channels: { telegram: { enabled: true } } })).toThrow(/only be set up by the owner/);
  });

  it("is in the settings view without any secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-view-"));
    const config = loadConfig(dir);
    config.channels.telegram.botToken = TOKEN;
    config.channels.twilio.authToken = "x";
    expect(JSON.stringify(settingsView(config))).not.toContain(TOKEN);
  });
});

describe("the channel routes", () => {
  it("are only for a signed-in browser", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/api/channels`)).status).toBe(401);
    expect((await fetch(`${base}/api/channels/telegram/link`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("make a link code only with the PIN and a saved bot token", async () => {
    const { api, save } = await boot();
    const post = (action: string, body: unknown) => api(`/api/channels/telegram/${action}`, { method: "POST", body: JSON.stringify(body) });
    expect((await post("link", {})).status).toBe(400); // no PIN
    expect((await post("link", { pin: owner.pin })).status).toBe(400); // Telegram is not switched on yet
    await save({ channels: { telegram: { enabled: true, botToken: TOKEN } } });
    expect([401, 403]).toContain((await post("link", { pin: "000000" })).status); // a wrong PIN is refused
    const ok = await post("link", { pin: owner.pin });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ code: expect.stringMatching(/^[A-Z2-9]{8}$/), expiresInSeconds: 600 });
    expect((await post("unlink", { pin: owner.pin })).status).toBe(200);
  });

  it("take Twilio's messages only with a valid signature, and only when a public address is set", async () => {
    const noUrl = await boot();
    const form = (p: Record<string, string>) => new URLSearchParams(p).toString();
    const post = (b: { base: string }, p: Record<string, string>, signature?: string) => fetch(`${b.base}/api/channels/twilio`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(signature ? { "x-twilio-signature": signature } : {}) }, body: form(p) });
    expect((await post(noUrl, { From: "+1", Body: "hi" })).status).toBe(503); // no public address to check a signature against
    await noUrl.save({ channels: { twilio: { enabled: true, accountSid: SID, authToken: "secret-auth", ownerNumber: "+919800000000" } } });
    expect((await post(noUrl, { From: "+1", Body: "hi" })).status).toBe(503); // no public address to check the signature against
    await app?.stop();

    const { base, save } = await boot({ publicUrl: "https://friend.example.com" });
    expect((await post({ base }, { From: "+1", Body: "hi" })).status).toBe(404); // Twilio is not switched on yet
    await save({ channels: { twilio: { enabled: true, accountSid: SID, authToken: "secret-auth", ownerNumber: "+919800000000" } } });
    const p = { From: "+15550001111", Body: "hello owner", MessageSid: "SM5" };
    expect((await post({ base }, p)).status).toBe(403);
    expect((await post({ base }, p, "wrong")).status).toBe(403);
    const sig = ChannelHub.twilioSignature("secret-auth", "https://friend.example.com/api/channels/twilio", p);
    const ok = await post({ base }, p, sig);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/xml/);
    expect(await ok.text()).toBe("<Response></Response>");
    // the message waits in the inbox as untrusted mail
    const rows = app!.channels.inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "sms", text: "hello owner" });
  });
});
