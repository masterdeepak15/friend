import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { ChannelHub, type SendableFile } from "./hub";

const TOKEN = "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1";
const SID = "AC" + "a".repeat(30);
const AUTH = "twilio-secret-token";
const OWNER_CHAT = 777;
const OWNER_NUMBER = "+919800000000";

interface Upload {
  method: string;
  chat: string;
  caption: string | null;
  field: string;
  filename: string;
  bytes: string;
}

class Net {
  uploads: Upload[] = [];
  twilio: { to: string; from: string; body: string | null; media: string | null }[] = [];
  telegramError: string | null = null;
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://api.telegram.org/")) {
      const method = url.split("/").pop()!;
      if (this.telegramError) return Response.json({ ok: false, description: this.telegramError.replace("TOKEN", TOKEN) });
      if (method === "getMe") return Response.json({ ok: true, result: { username: "friend_test_bot" } });
      if (method === "getUpdates") return Response.json({ ok: true, result: [] });
      if (init?.body instanceof FormData) {
        const form = init.body;
        const field = ["photo", "audio", "video", "document", "voice"].find((f) => form.has(f))!;
        const file = form.get(field) as File;
        this.uploads.push({ method, chat: String(form.get("chat_id")), caption: (form.get("caption") as string | null) ?? null, field, filename: file.name, bytes: await file.text() });
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    if (url.startsWith("https://api.twilio.com/") && url.endsWith("/Messages.json")) {
      const form = new URLSearchParams(String(init?.body ?? ""));
      this.twilio.push({ to: form.get("To")!, from: form.get("From")!, body: form.get("Body"), media: form.get("MediaUrl") });
      return Response.json({ sid: "SM1" }, { status: 201 });
    }
    throw new Error(`unexpected request ${url}`);
  };
}

let hubs: ChannelHub[] = [];
afterEach(() => {
  for (const h of hubs) h.stop();
  hubs = [];
});

function make(opts: { publicBase?: string | null; now?: () => number; ownerChat?: number | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-sendfile-"));
  const config: Config = loadConfig(dir);
  config.channels.telegram = { installed: true, enabled: true, botToken: TOKEN, ownerChatId: opts.ownerChat === undefined ? OWNER_CHAT : opts.ownerChat };
  config.channels.twilio = { installed: true, enabled: true, accountSid: SID, authToken: AUTH, smsFrom: "+14155550100", whatsappFrom: "+14155550101", ownerNumber: OWNER_NUMBER };
  const db = openDb(dir);
  const net = new Net();
  const hub = new ChannelHub({
    config,
    db,
    audit: new Audit(db),
    ask: async () => "ok",
    notify: (_m: ServerMsg) => {},
    fetch: net.fetch,
    pollSeconds: 0,
    ...(opts.now ? { clock: opts.now } : {}),
    publicBase: () => (opts.publicBase === undefined ? "https://friend.example.com" : opts.publicBase),
  });
  hubs.push(hub);
  const file = (name: string, kind: SendableFile["kind"], mime: string, content = "FILEBYTES", size?: number): SendableFile => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return { path, name, mime, size: size ?? content.length, kind };
  };
  return { hub, net, file, dir };
}

describe("sending a file on Telegram", () => {
  it("sends a picture as a photo, to the owner, with the caption", async () => {
    const t = make();
    const r = await t.hub.sendFile("telegram", "me", t.file("test.png", "image", "image/png"), "Here you go");
    expect(r).toEqual({ ok: true, summary: expect.stringMatching(/Telegram/) });
    expect(t.net.uploads).toEqual([{ method: "sendPhoto", chat: String(OWNER_CHAT), caption: "Here you go", field: "photo", filename: "test.png", bytes: "FILEBYTES" }]);
  });

  it("uses the right kind of message for audio, video and documents, and a document for what a photo cannot be", async () => {
    const t = make();
    await t.hub.sendFile("telegram", "me", t.file("a.mp3", "audio", "audio/mpeg"));
    await t.hub.sendFile("telegram", "me", t.file("v.mp4", "video", "video/mp4"));
    await t.hub.sendFile("telegram", "me", t.file("r.pdf", "document", "application/pdf"));
    await t.hub.sendFile("telegram", "me", t.file("g.gif", "image", "image/gif"));
    await t.hub.sendFile("telegram", "me", t.file("big.jpg", "image", "image/jpeg", "x", 11_000_000));
    expect(t.net.uploads.map((u) => [u.method, u.field])).toEqual([
      ["sendAudio", "audio"],
      ["sendVideo", "video"],
      ["sendDocument", "document"],
      ["sendDocument", "document"],
      ["sendDocument", "document"],
    ]);
  });

  it("refuses a file Telegram would not take, and says so", async () => {
    const t = make();
    const r = await t.hub.sendFile("telegram", "me", t.file("huge.zip", "document", "application/zip", "x", 60_000_000));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/too big/i) });
    expect(t.net.uploads).toHaveLength(0);
  });

  it("needs a linked chat, and goes to the owner only", async () => {
    const t = make({ ownerChat: null });
    expect(await t.hub.sendFile("telegram", "me", t.file("a.png", "image", "image/png"))).toEqual({ ok: false, error: expect.stringMatching(/not linked/i) });
    expect(await t.hub.sendFile("telegram", "someone", t.file("a.png", "image", "image/png"))).toEqual({ ok: false, error: expect.stringMatching(/only be sent to the owner/i) });
  });

  it("shows no token when Telegram refuses", async () => {
    const t = make();
    t.net.telegramError = "Bad Request: wrong file for TOKEN";
    const r = await t.hub.sendFile("telegram", "me", t.file("a.png", "image", "image/png"));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("cuts a caption to what Telegram allows", async () => {
    const t = make();
    await t.hub.sendFile("telegram", "me", t.file("a.png", "image", "image/png"), "c".repeat(3000));
    expect(t.net.uploads[0]!.caption!.length).toBeLessThanOrEqual(1024);
  });
});

describe("sending a file on WhatsApp", () => {
  it("gives Twilio a short-lived address of Friend's own and sends it to the owner's number", async () => {
    const t = make();
    const r = await t.hub.sendFile("whatsapp", "me", t.file("test.png", "image", "image/png"), "Here you go");
    expect(r.ok).toBe(true);
    expect(t.net.twilio).toHaveLength(1);
    const m = t.net.twilio[0]!;
    expect(m).toMatchObject({ to: `whatsapp:${OWNER_NUMBER}`, from: "whatsapp:+14155550101", body: "Here you go" });
    expect(m.media).toMatch(/^https:\/\/friend\.example\.com\/api\/channels\/media\/[0-9a-f]{32}$/);
    const token = m.media!.split("/").pop()!;
    expect(t.hub.mediaFor(token)).toMatchObject({ mime: "image/png", name: "test.png" });
  });

  it("serves the file only for a little while, and only to the token", async () => {
    let now = 1_000_000;
    const t = make({ now: () => now });
    await t.hub.sendFile("whatsapp", "me", t.file("test.png", "image", "image/png"));
    const token = t.net.twilio[0]!.media!.split("/").pop()!;
    expect(t.hub.mediaFor(token)).not.toBeNull();
    expect(t.hub.mediaFor("0".repeat(32))).toBeNull();
    expect(t.hub.mediaFor("../x")).toBeNull();
    now += 11 * 60_000;
    expect(t.hub.mediaFor(token)).toBeNull();
  });

  it("needs Friend's public address, and says so", async () => {
    const t = make({ publicBase: null });
    const r = await t.hub.sendFile("whatsapp", "me", t.file("a.png", "image", "image/png"));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/public address/i) });
    expect(t.net.twilio).toHaveLength(0);
  });

  it("refuses a file WhatsApp would not take", async () => {
    const t = make();
    const r = await t.hub.sendFile("whatsapp", "me", t.file("huge.mp4", "video", "video/mp4", "x", 20_000_000));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/too big/i) });
  });
});

describe("sending a file by SMS", () => {
  it("is not possible, and the sentence names the channels that work", async () => {
    const t = make();
    const r = await t.hub.sendFile("sms", "me", t.file("a.png", "image", "image/png"));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/SMS cannot carry files.*Telegram.*WhatsApp/i) });
  });
});
