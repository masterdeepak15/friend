import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { ChannelHub, type ChannelId } from "./hub";

const TOKEN = "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1";
const SID = "AC" + "a".repeat(30);
const AUTH = "twilio-secret-token";
const OWNER_CHAT = 777;
const OWNER_NUMBER = "+919800000000";
const MEDIA = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME1`;
const CDN = "https://media.twiliocdn.com/AC1/abc";
const URL_WEBHOOK = "https://friend.example.com/api/channels/twilio";

class Net {
  updates: unknown[] = [];
  sent: { chat: number; text: string }[] = [];
  twilioOut: { to: string; body: string }[] = [];
  downloads: { url: string; auth: string | undefined }[] = [];
  getFile: { file_path?: string; file_size?: number } | { error: string } = { file_path: "voice/file_1.oga", file_size: 2000 };
  audio = Buffer.from("OGGBYTES");
  mediaRedirect: string | null = null;
  downloadStatus = 200;
  private id = 0;
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.startsWith("https://api.telegram.org/file/")) {
      this.downloads.push({ url, auth: undefined });
      return this.downloadStatus === 200 ? new Response(this.audio, { status: 200, headers: { "content-length": String(this.audio.length) } }) : new Response("no", { status: this.downloadStatus });
    }
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop()!;
      const json = body ? JSON.parse(body) : {};
      if (method === "getMe") return Response.json({ ok: true, result: { username: "friend_test_bot" } });
      if (method === "getUpdates") return Response.json({ ok: true, result: this.updates.splice(0) });
      if (method === "getFile") return "error" in this.getFile ? Response.json({ ok: false, description: this.getFile.error.replace("TOKEN", TOKEN) }) : Response.json({ ok: true, result: this.getFile });
      if (method === "sendMessage") {
        this.sent.push({ chat: json.chat_id, text: json.text });
        return Response.json({ ok: true, result: { message_id: ++this.id } });
      }
      return Response.json({ ok: true, result: true });
    }
    if (url.startsWith("https://api.twilio.com/2010-04-01/Accounts/") && url.endsWith("/Messages.json")) {
      const form = new URLSearchParams(body);
      this.twilioOut.push({ to: form.get("To")!, body: form.get("Body")! });
      return Response.json({ sid: "SM1" }, { status: 201 });
    }
    if (url.startsWith("https://api.twilio.com/") || url.startsWith("https://media.twiliocdn.com/")) {
      this.downloads.push({ url, auth: headers.authorization });
      if (this.mediaRedirect && url.startsWith("https://api.twilio.com/")) return new Response(null, { status: 307, headers: { location: this.mediaRedirect } });
      return new Response(this.audio, { status: 200, headers: { "content-type": "audio/ogg" } });
    }
    throw new Error(`unexpected request ${url}`);
  };
  voice(chat: number, over: Record<string, unknown> = {}, kind: "voice" | "audio" = "voice") {
    this.updates.push({ update_id: ++this.id + 1000, message: { chat: { id: chat }, from: { username: "someone" }, [kind]: { file_id: "F1", duration: 5, file_size: 2000, mime_type: "audio/ogg", ...over } } });
  }
}

let hubs: ChannelHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  hubs = [];
});

type Heard = { ok: true; text: string } | { ok: false; error: string };
function make(opts: { transcribe?: ((audio: Buffer, mime: string) => Promise<Heard>) | null; reply?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-voice-msg-"));
  const config: Config = loadConfig(dir);
  config.channels.telegram = { installed: true, enabled: true, botToken: TOKEN, ownerChatId: OWNER_CHAT };
  config.channels.twilio = { installed: true, enabled: true, accountSid: SID, authToken: AUTH, smsFrom: "+14155550100", whatsappFrom: "+14155550101", ownerNumber: OWNER_NUMBER };
  config.publicUrl = "https://friend.example.com";
  const db = openDb(dir);
  const net = new Net();
  const asks: string[] = [];
  const heard: { bytes: string; mime: string }[] = [];
  const transcribe =
    opts.transcribe === null
      ? undefined
      : (opts.transcribe ??
        (async (audio: Buffer, mime: string): Promise<Heard> => {
          heard.push({ bytes: audio.toString(), mime });
          return { ok: true, text: "play some jazz" };
        }));
  const hub = new ChannelHub({
    config,
    db,
    audit: new Audit(db),
    ask: async (t, _via: ChannelId) => {
      asks.push(t);
      return opts.reply ?? "Playing jazz.";
    },
    notify: (_m: ServerMsg) => {},
    ...(transcribe ? { transcribe } : {}),
    fetch: net.fetch,
    pollSeconds: 0,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
  });
  hubs.push(hub);
  const sign = (params: Record<string, string>) => ChannelHub.twilioSignature(AUTH, URL_WEBHOOK, params);
  const whatsappVoice = (over: Record<string, string> = {}, from = `whatsapp:${OWNER_NUMBER}`) => {
    const params = { MessageSid: "SM" + Math.random().toString(36).slice(2), From: from, Body: "", NumMedia: "1", MediaUrl0: MEDIA, MediaContentType0: "audio/ogg", ...over };
    return hub.handleTwilio(URL_WEBHOOK, params, sign(params));
  };
  return { hub, net, asks, heard, whatsappVoice, config };
}
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};
const lastSent = (net: Net) => net.sent.at(-1)?.text ?? "";

describe("Telegram voice messages from the owner", () => {
  it("are downloaded, understood, answered, and the reply says what was heard", async () => {
    const t = make();
    t.hub.apply();
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 0);
    expect(t.heard).toEqual([{ bytes: "OGGBYTES", mime: "audio/ogg" }]);
    expect(t.asks).toEqual(["play some jazz"]);
    expect(lastSent(t.net)).toContain("play some jazz");
    expect(lastSent(t.net)).toContain("Playing jazz.");
    expect(t.net.downloads[0]!.url).toBe(`https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`);
  });

  it("also work as an audio file", async () => {
    const t = make();
    t.hub.apply();
    t.net.voice(OWNER_CHAT, { mime_type: "audio/mpeg" }, "audio");
    await until(() => t.net.sent.length > 0);
    expect(t.heard[0]!.mime).toBe("audio/mpeg");
    expect(t.asks).toEqual(["play some jazz"]);
  });

  it("say so when the voice engine is not set up, and ask nothing", async () => {
    const t = make({ transcribe: null });
    t.hub.apply();
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 0);
    expect(lastSent(t.net)).toMatch(/voice/i);
    expect(t.asks).toHaveLength(0);
    expect(t.net.downloads).toHaveLength(0);
  });

  it("say what the voice engine said when it cannot understand, and ask nothing", async () => {
    const t = make({ transcribe: async () => ({ ok: false, error: "The voice engine is not running." }) });
    t.hub.apply();
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 0);
    expect(lastSent(t.net)).toContain("The voice engine is not running.");
    expect(t.asks).toHaveLength(0);
  });

  it("say when there were no words in it", async () => {
    const t = make({ transcribe: async () => ({ ok: true, text: "   " }) });
    t.hub.apply();
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 0);
    expect(lastSent(t.net)).toMatch(/could not hear any words/i);
    expect(t.asks).toHaveLength(0);
  });

  it("that are too long or too big are not downloaded, and the owner is told", async () => {
    const t = make();
    t.hub.apply();
    t.net.voice(OWNER_CHAT, { duration: 4000 });
    await until(() => t.net.sent.length > 0);
    expect(lastSent(t.net)).toMatch(/too long/i);
    t.net.voice(OWNER_CHAT, { file_size: 500_000_000 });
    await until(() => t.net.sent.length > 1);
    expect(lastSent(t.net)).toMatch(/too (long|big)/i);
    expect(t.net.downloads).toHaveLength(0);
    expect(t.asks).toHaveLength(0);
  });

  it("that turn out bigger than they said are refused after the download", async () => {
    const t = make();
    t.net.audio = Buffer.alloc(9_000_000, 1);
    t.hub.apply();
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 0);
    expect(lastSent(t.net)).toMatch(/too (long|big)/i);
    expect(t.asks).toHaveLength(0);
  });

  it("that cannot be fetched are one sentence with no token in it", async () => {
    const t = make();
    t.net.getFile = { error: "Bad Request: file is too big for TOKEN" };
    t.hub.apply();
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 0);
    expect(lastSent(t.net)).toMatch(/could not/i);
    expect(JSON.stringify(t.net.sent)).not.toContain(TOKEN);
    t.net.getFile = { file_path: "voice/file_1.oga", file_size: 2000 };
    t.net.downloadStatus = 500;
    t.net.voice(OWNER_CHAT);
    await until(() => t.net.sent.length > 1);
    expect(JSON.stringify(t.net.sent)).not.toContain(TOKEN);
  });
});

describe("Telegram voice messages from anyone else", () => {
  it("are ignored: nothing downloaded, nothing understood, nothing answered", async () => {
    const t = make();
    t.hub.apply();
    t.net.voice(555);
    await new Promise((r) => setTimeout(r, 120));
    expect(t.net.downloads).toHaveLength(0);
    expect(t.heard).toHaveLength(0);
    expect(t.asks).toHaveLength(0);
    expect(t.net.sent).toHaveLength(0);
  });
});

describe("WhatsApp voice messages from the owner", () => {
  it("are downloaded with the account's login, understood, answered on WhatsApp", async () => {
    const t = make();
    expect(t.whatsappVoice()).toBe("ok");
    await until(() => t.net.twilioOut.length > 0);
    expect(t.heard).toEqual([{ bytes: "OGGBYTES", mime: "audio/ogg" }]);
    expect(t.net.downloads[0]!.auth).toBe("Basic " + Buffer.from(`${SID}:${AUTH}`).toString("base64"));
    expect(t.asks).toEqual(["play some jazz"]);
    expect(t.net.twilioOut[0]!.to).toBe(`whatsapp:${OWNER_NUMBER}`);
    expect(t.net.twilioOut[0]!.body).toContain("play some jazz");
    expect(t.net.twilioOut[0]!.body).toContain("Playing jazz.");
  });

  it("follow Twilio's redirect to its media host without sending the login there", async () => {
    const t = make();
    t.net.mediaRedirect = CDN;
    t.whatsappVoice();
    await until(() => t.asks.length > 0);
    expect(t.net.downloads.map((d) => d.url)).toEqual([MEDIA, CDN]);
    expect(t.net.downloads[0]!.auth).toMatch(/^Basic /);
    expect(t.net.downloads[1]!.auth).toBeUndefined();
  });

  it("are refused when the media address is not Twilio's, or the redirect leaves Twilio, and the login is never sent", async () => {
    const t = make();
    t.whatsappVoice({ MediaUrl0: "https://evil.example.com/a.ogg" });
    await until(() => t.net.twilioOut.length > 0);
    expect(t.net.twilioOut[0]!.body).toMatch(/could not/i);
    expect(t.net.downloads).toHaveLength(0);
    const u = make();
    u.net.mediaRedirect = "http://169.254.169.254/latest";
    u.whatsappVoice();
    await until(() => u.net.twilioOut.length > 0);
    expect(u.net.downloads.map((d) => d.url)).toEqual([MEDIA]);
    expect(u.asks).toHaveLength(0);
  });

  it("are ignored when they are not audio, and when the words are in the text instead", async () => {
    const t = make();
    t.whatsappVoice({ MediaContentType0: "image/jpeg" });
    await new Promise((r) => setTimeout(r, 100));
    expect(t.net.downloads).toHaveLength(0);
    expect(t.asks).toHaveLength(0);
    t.whatsappVoice({ Body: "hello there" });
    await until(() => t.asks.length > 0);
    expect(t.asks).toEqual(["hello there"]);
    expect(t.net.downloads).toHaveLength(0);
  });

  it("say so when the voice engine is not set up", async () => {
    const t = make({ transcribe: null });
    t.whatsappVoice();
    await until(() => t.net.twilioOut.length > 0);
    expect(t.net.twilioOut[0]!.body).toMatch(/voice/i);
    expect(t.asks).toHaveLength(0);
  });
});

describe("WhatsApp voice messages from anyone else", () => {
  it("are ignored", async () => {
    const t = make();
    expect(t.whatsappVoice({}, "whatsapp:+15550001111")).toBe("ok");
    await new Promise((r) => setTimeout(r, 100));
    expect(t.net.downloads).toHaveLength(0);
    expect(t.heard).toHaveLength(0);
    expect(t.asks).toHaveLength(0);
    expect(t.net.twilioOut).toHaveLength(0);
  });
});
