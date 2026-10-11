import type { ServerMsg } from "@friend/protocol";
import { promises as fsp } from "node:fs";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Audit } from "../audit";
import { loadConfig, phoneNumber, saveConfig, type Config } from "../config";
import type { Db } from "../db";

export type ChannelId = "telegram" | "sms" | "whatsapp";
export const CHANNEL_LABEL: Record<ChannelId, string> = { telegram: "Telegram", sms: "SMS", whatsapp: "WhatsApp" };

export interface InboxRow {
  id: number;
  channel: ChannelId;
  direction: "in" | "out";
  peer: string;
  name: string;
  text: string;
  ts: number;
  read: boolean;
}

export type SendResult = { ok: true; summary: string } | { ok: false; error: string };

/** A file ready to be sent to a chat (checked by MediaStore.sendable). */
export interface SendableFile {
  path: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "audio" | "video" | "document";
}

export interface HubDeps {
  /** The address people reach Friend at from outside, or null when there is none (WhatsApp files need one). */
  publicBase?: () => string | null;
  config: Config;
  db: Db;
  audit: Audit;
  /** Runs one request that came from the owner's own chat and resolves with the reply to send back. */
  ask(text: string, via: ChannelId): Promise<string>;
  /** Turns a voice message into words, or says why it cannot. Left out when there is no voice engine. */
  transcribe?(audio: Buffer, mime: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Tells every open screen something (for example that a message arrived). */
  notify(m: ServerMsg): void;
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long Telegram holds a poll open waiting for news (seconds). */
  pollSeconds?: number;
}

export interface ChannelStatus {
  telegram: { enabled: boolean; tokenSet: boolean; linked: boolean; state: "off" | "connecting" | "online" | "error"; detail: string; bot: string | null };
  twilio: { enabled: boolean; tokenSet: boolean; ownerSet: boolean; sms: boolean; whatsapp: boolean; webhook: string | null };
}

interface TelegramClip {
  file_id: string;
  duration?: number;
  file_size?: number;
  mime_type?: string;
}

/** A voice message that cannot be used; the message is safe to send back to the owner. */
class VoiceMessageError extends Error {}

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; voice?: TelegramClip; audio?: TelegramClip; chat: { id: number }; from?: { username?: string; first_name?: string } };
}

const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_TTL_MS = 10 * 60_000;
const LINK_MAX_FAILS = 5;
const INBOX_KEEP = 500;
const TELEGRAM_CHUNK = 4000;
const SMS_MAX = 1500;
/** The owner's own chat may send this many messages in a window; others are only stored, a few per hour per sender. */
/** A voice message longer or bigger than this is not downloaded (what the owner is told says so). */
const VOICE_MAX_SECONDS = 300;
const VOICE_MAX_BYTES = 8_000_000;
const VOICE_FETCH_MS = 20_000;
const TWILIO_MEDIA_HOSTS = /(^|\.)(twilio\.com|twiliocdn\.com|amazonaws\.com)$/;
/** What each chat takes as a file, and how long WhatsApp may fetch a file from Friend. */
const TELEGRAM_FILE_MAX = 50_000_000;
const TELEGRAM_PHOTO_MAX = 10_000_000;
const TELEGRAM_CAPTION = 1024;
const WHATSAPP_FILE_MAX = 16_000_000;
const OUTBOX_TTL_MS = 10 * 60_000;
const OUTBOX_MAX = 20;
const OWNER_LIMIT = { max: 20, windowMs: 5 * 60_000 };
const STRANGER_LIMIT = { max: 20, windowMs: 3600_000 };

const t0 = (token: string | null): string => token ?? "";

/** The body of a response, as bytes; refused if it is bigger than the limit (checked as it arrives, not afterwards). */
async function readLimited(res: Response, max: number): Promise<Buffer> {
  const tooBig = () => new VoiceMessageError("That voice message is too big. Send a shorter one.");
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    void res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ");
const digits = (s: string) => s.replace(/\D/g, "");

/** Telegram, SMS and WhatsApp: reads what comes in, hands the owner's own messages to the assistant, and sends on its behalf. */
export class ChannelHub {
  private f: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private tgGen = 0;
  private tgAbort: AbortController | null = null;
  private tgOffset = 0;
  private tgState: ChannelStatus["telegram"]["state"] = "off";
  private tgDetail = "";
  private tgBot: string | null = null;
  private link: { code: string; expires: number; fails: number } | null = null;
  private seen: string[] = [];
  /** Files waiting for Twilio to fetch them (WhatsApp takes a media address, not an upload): random token, ten minutes. */
  private outbox = new Map<string, { path: string; mime: string; name: string; expires: number }>();
  private hits = new Map<string, number[]>();

  constructor(private deps: HubDeps) {
    this.f = deps.fetch ?? fetch;
    this.now = deps.clock ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get cfg() {
    return this.deps.config.channels;
  }

  // ---- lifecycle -----------------------------------------------------------------------------------------------

  /** (Re)starts what the settings ask for. Call it at start and after the channel settings change. */
  apply(): void {
    this.tgGen++;
    this.tgAbort?.abort();
    this.tgAbort = null;
    this.tgBot = null;
    const t = this.cfg.telegram;
    if (!t.installed || !t.enabled || !t.botToken) {
      this.tgState = "off";
      this.tgDetail = "";
      return;
    }
    this.tgState = "connecting";
    this.tgDetail = "";
    this.tgAbort = new AbortController();
    void this.pollTelegram(this.tgGen, this.tgAbort.signal);
  }

  stop(): void {
    this.tgGen++;
    this.tgAbort?.abort();
    this.tgAbort = null;
    this.tgState = "off";
  }

  status(): ChannelStatus {
    const t = this.cfg.telegram;
    const w = this.cfg.twilio;
    return {
      telegram: { enabled: t.enabled, tokenSet: !!t.botToken, linked: t.ownerChatId !== null, state: this.tgState, detail: this.tgDetail, bot: this.tgBot },
      twilio: { enabled: w.enabled, tokenSet: !!w.authToken && !!w.accountSid, ownerSet: !!w.ownerNumber, sms: !!w.smsFrom, whatsapp: !!w.whatsappFrom, webhook: this.deps.config.publicUrl ? `${this.deps.config.publicUrl.replace(/\/+$/, "")}/api/channels/twilio` : null },
    };
  }

  // ---- the inbox -----------------------------------------------------------------------------------------------

  private record(channel: ChannelId, direction: "in" | "out", peer: string, name: string, text: string): void {
    this.deps.db.prepare("insert into channel_messages (channel, direction, peer, name, text, ts, read) values (?, ?, ?, ?, ?, ?, ?)").run(channel, direction, peer, name, clip(text, 4000), this.now(), direction === "out" ? 1 : 0);
    this.deps.db.prepare("delete from channel_messages where id <= (select max(id) from channel_messages) - ?").run(INBOX_KEEP);
  }

  /** The newest messages (oldest first), and what was unread is now read. */
  inbox(opts: { channel?: ChannelId | undefined; unread?: boolean | undefined; limit?: number | undefined } = {}): InboxRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 20);
    const where = ["direction = 'in'"];
    const args: unknown[] = [];
    if (opts.channel) {
      where.push("channel = ?");
      args.push(opts.channel);
    }
    if (opts.unread) where.push("read = 0");
    const rows = this.deps.db.prepare(`select id, channel, direction, peer, name, text, ts, read from channel_messages where ${where.join(" and ")} order by id desc limit ?`).all(...args, limit) as (Omit<InboxRow, "read"> & { read: number })[];
    for (const r of rows) this.deps.db.prepare("update channel_messages set read = 1 where id = ?").run(r.id);
    return rows.reverse().map((r) => ({ ...r, read: r.read === 1 }));
  }

  unreadCount(): number {
    return (this.deps.db.prepare("select count(*) n from channel_messages where direction = 'in' and read = 0").get() as { n: number }).n;
  }

  private allowed(key: string, limit: { max: number; windowMs: number }): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < limit.windowMs);
    if (recent.length >= limit.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  // ---- telegram ------------------------------------------------------------------------------------------------

  private mask(message: string): string {
    const token = this.cfg.telegram.botToken;
    return token ? message.split(token).join("***") : message;
  }

  private async tg<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const token = this.cfg.telegram.botToken;
    if (!token) throw new Error("No Telegram bot token is set.");
    const res = await this.f(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new Error(json.description ?? `Telegram answered ${res.status}`);
    return json.result as T;
  }

  private async pollTelegram(gen: number, signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (gen === this.tgGen && !signal.aborted) {
      try {
        if (!this.tgBot) {
          const me = await this.tg<{ username?: string }>("getMe", {}, signal);
          this.tgBot = me.username ?? null;
        }
        const updates = await this.tg<TelegramUpdate[]>("getUpdates", { offset: this.tgOffset, timeout: this.deps.pollSeconds ?? 25, allowed_updates: ["message"] }, signal);
        if (gen !== this.tgGen) return;
        this.tgState = "online";
        this.tgDetail = "";
        backoff = 1000;
        for (const u of updates) {
          this.tgOffset = Math.max(this.tgOffset, u.update_id + 1);
          try {
            await this.onTelegram(u);
          } catch (e) {
            this.deps.audit.log("system", "channel.telegram_handler_failed", { message: this.mask((e as Error).message).slice(0, 200) });
          }
        }
        if (updates.length === 0 && (this.deps.pollSeconds ?? 25) === 0) await this.sleep(10); // a test poll that returns at once must not spin
      } catch (e) {
        if (signal.aborted || gen !== this.tgGen) return;
        this.tgState = "error";
        this.tgDetail = this.mask((e as Error).message).slice(0, 160);
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** A one-time code to send to the bot as /link CODE. Whoever does it from their Telegram becomes the owner's chat. */
  linkTelegram(): { code: string; bot: string | null; expiresInSeconds: number } {
    const code = Array.from({ length: 8 }, () => LINK_ALPHABET[randomInt(LINK_ALPHABET.length)]).join("");
    this.link = { code, expires: this.now() + LINK_TTL_MS, fails: 0 };
    return { code, bot: this.tgBot, expiresInSeconds: LINK_TTL_MS / 1000 };
  }

  /** Remembers which chat is the owner's, in memory and in the saved file (only this value: nothing else in memory reaches the file). */
  private setOwnerChat(chat: number | null): void {
    this.cfg.telegram.ownerChatId = chat;
    const saved = loadConfig(this.deps.config.dataDir);
    saved.channels.telegram.ownerChatId = chat;
    saveConfig(saved);
  }

  unlinkTelegram(): void {
    this.setOwnerChat(null);
    this.link = null;
    this.deps.audit.log("owner", "channel.telegram_unlinked", {});
  }

  private async onTelegram(u: TelegramUpdate): Promise<void> {
    const m = u.message;
    if (!m) return;
    if (typeof m.text !== "string" || !m.text.trim()) {
      const clip = m.voice ?? m.audio;
      return clip ? this.onTelegramVoice(m.chat.id, clip) : undefined;
    }
    const chat = m.chat.id;
    const text = m.text.trim().slice(0, 4000);
    const name = plain(m.from?.username ?? m.from?.first_name ?? String(chat)).slice(0, 60);
    const t = this.cfg.telegram;

    const linkTry = /^\/link\s+(\S+)$/i.exec(text);
    if (linkTry) return this.tryLink(chat, linkTry[1]!);

    if (t.ownerChatId !== null && chat === t.ownerChatId) {
      if (/^\/start\b/i.test(text)) return void (await this.sendRaw("telegram", String(chat), "I am here. Talk to me like you would on your PC."));
      if (!this.allowed(`owner:${chat}`, OWNER_LIMIT)) return void (await this.sendRaw("telegram", String(chat), "Slow down a little: too many messages in a short time."));
      return this.respond("telegram", String(chat), text);
    }

    // anyone else: kept as untrusted data for the owner to read, never run, never answered
    if (!this.allowed(`stranger:telegram:${chat}`, STRANGER_LIMIT)) return;
    this.record("telegram", "in", String(chat), name, text);
    this.deps.audit.log("system", "channel.message_in", { channel: "telegram", from: name });
    this.deps.notify({ type: "alert", level: "info", text: `New Telegram message from ${name}: ${clip(plain(text), 80)}` });
  }

  /** A voice message from the owner's chat is understood and answered like a typed one. From anyone else it is ignored. */
  private async onTelegramVoice(chat: number, clip: TelegramClip): Promise<void> {
    const t = this.cfg.telegram;
    if (t.ownerChatId === null || chat !== t.ownerChatId) return;
    if (!this.allowed(`owner:${chat}`, OWNER_LIMIT)) return void (await this.sendRaw("telegram", String(chat), "Slow down a little: too many messages in a short time."));
    await this.tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});
    await this.answerVoice("telegram", String(chat), () => this.telegramAudio(clip));
  }

  private async telegramAudio(clip: TelegramClip): Promise<{ audio: Buffer; mime: string }> {
    const fail = () => new VoiceMessageError("I could not fetch that voice message from Telegram. Try sending it again.");
    if ((clip.duration ?? 0) > VOICE_MAX_SECONDS) throw new VoiceMessageError(`That voice message is too long. Send one under ${VOICE_MAX_SECONDS / 60} minutes.`);
    if ((clip.file_size ?? 0) > VOICE_MAX_BYTES) throw new VoiceMessageError("That voice message is too big. Send a shorter one.");
    const token = t0(this.cfg.telegram.botToken);
    let info: { file_path?: string; file_size?: number };
    try {
      info = await this.tg<{ file_path?: string; file_size?: number }>("getFile", { file_id: clip.file_id });
    } catch {
      throw fail();
    }
    if (!info.file_path || !/^[\w\-./]+$/.test(info.file_path) || info.file_path.includes("..")) throw fail();
    if ((info.file_size ?? 0) > VOICE_MAX_BYTES) throw new VoiceMessageError("That voice message is too big. Send a shorter one.");
    let res: Response;
    try {
      res = await this.f(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(VOICE_FETCH_MS) });
    } catch {
      throw fail();
    }
    if (!res.ok) throw fail();
    return { audio: await readLimited(res, VOICE_MAX_BYTES), mime: clip.mime_type?.toLowerCase().startsWith("audio/") ? clip.mime_type : "audio/ogg" };
  }

  /** Downloads, understands and answers a voice message; whatever goes wrong is told to the owner in one sentence. */
  private async answerVoice(channel: ChannelId, peer: string, get: () => Promise<{ audio: Buffer; mime: string }>): Promise<void> {
    let heard: string;
    try {
      if (!this.deps.transcribe) throw new VoiceMessageError("I can't understand voice messages yet: the voice engine is not set up on the PC.");
      const { audio, mime } = await get();
      const r = await this.deps.transcribe(audio, mime);
      if (!r.ok) throw new VoiceMessageError(r.error);
      heard = r.text.trim().slice(0, 1600);
      if (!heard) throw new VoiceMessageError("I could not hear any words in that voice message.");
    } catch (e) {
      const text = e instanceof VoiceMessageError ? e.message : "I could not understand that voice message.";
      if (!(e instanceof VoiceMessageError)) this.deps.audit.log("system", "channel.voice_failed", { message: this.mask((e as Error).message).slice(0, 200) });
      await this.sendRaw(channel, peer, text).catch(() => {});
      return;
    }
    await this.respond(channel, peer, heard, heard);
  }

  /** The audio of a WhatsApp or SMS message. Twilio keeps it at its own address and wants the account's login to hand it over. */
  private async twilioAudio(mediaUrl: string, mime: string): Promise<{ audio: Buffer; mime: string }> {
    const w = this.cfg.twilio;
    const fail = () => new VoiceMessageError("I could not fetch that voice message from WhatsApp. Try sending it again.");
    let url: URL;
    try {
      url = new URL(mediaUrl);
    } catch {
      throw fail();
    }
    if (url.protocol !== "https:" || url.hostname !== "api.twilio.com") throw fail();
    const login = "Basic " + Buffer.from(`${w.accountSid}:${w.authToken ?? ""}`).toString("base64");
    try {
      let res = await this.f(url.toString(), { headers: { authorization: login }, redirect: "manual", signal: AbortSignal.timeout(VOICE_FETCH_MS) });
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {});
        const next = new URL(res.headers.get("location") ?? "", url);
        // the login goes to api.twilio.com only; the media host it points to gets none
        if (next.protocol !== "https:" || !TWILIO_MEDIA_HOSTS.test(next.hostname)) throw fail();
        res = await this.f(next.toString(), { redirect: "manual", signal: AbortSignal.timeout(VOICE_FETCH_MS) });
      }
      if (!res.ok) throw fail();
      return { audio: await readLimited(res, VOICE_MAX_BYTES), mime: mime.toLowerCase() };
    } catch (e) {
      throw e instanceof VoiceMessageError ? e : fail();
    }
  }

  private async tryLink(chat: number, code: string): Promise<void> {
    const l = this.link;
    if (!l || l.expires <= this.now()) {
      this.link = null;
      return void (await this.sendRaw("telegram", String(chat), "There is no link code waiting. Create one on the Friend screen: Plugins, Telegram, Configure."));
    }
    const a = Buffer.from(code.toUpperCase());
    const b = Buffer.from(l.code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.setOwnerChat(chat);
      this.link = null;
      this.deps.audit.log("owner", "channel.telegram_linked", {});
      this.deps.notify({ type: "alert", level: "info", text: "Telegram is linked. You can talk to Friend from there now." });
      return void (await this.sendRaw("telegram", String(chat), "Linked. You can talk to me here now."));
    }
    l.fails++;
    this.deps.audit.log("system", "channel.link_failed", { fails: l.fails });
    if (l.fails >= LINK_MAX_FAILS) this.link = null; // too many wrong guesses: the code is gone
    await this.sendRaw("telegram", String(chat), "That code is not right.");
  }

  // ---- asking the assistant ------------------------------------------------------------------------------------

  private async respond(channel: ChannelId, peer: string, text: string, heard?: string): Promise<void> {
    this.record(channel, "in", peer, "owner", text);
    this.deps.audit.log("owner", "channel.message_in", { channel, via: "owner" });
    if (channel === "telegram") await this.tg("sendChatAction", { chat_id: Number(peer), action: "typing" }).catch(() => {});
    let reply: string;
    try {
      reply = (await this.deps.ask(text, channel)).trim();
    } catch (e) {
      this.deps.audit.log("system", "channel.ask_failed", { message: (e as Error).message.slice(0, 200) });
      reply = "Something went wrong on my side. Try again in a moment.";
    }
    reply = reply || "Done.";
    await this.sendRaw(channel, peer, heard ? `🎙 “${clip(plain(heard), 300)}”\n\n${reply}` : reply);
  }

  // ---- sending -------------------------------------------------------------------------------------------------

  private async sendRaw(channel: ChannelId, to: string, text: string): Promise<void> {
    if (channel === "telegram") {
      for (let i = 0; i < text.length; i += TELEGRAM_CHUNK) await this.tg("sendMessage", { chat_id: Number(to), text: text.slice(i, i + TELEGRAM_CHUNK) });
    } else {
      await this.twilioSend(to, text, channel === "whatsapp");
    }
    this.record(channel, "out", to, "", text);
  }

  /** Sends a message on the owner's behalf. `to` is "me", a Telegram chat id, or a phone number in international form. */
  async send(channel: ChannelId, to: string, text: string): Promise<SendResult> {
    const body = text.trim();
    if (!body) return { ok: false, error: "There is no message text." };
    try {
      if (channel === "telegram") {
        const t = this.cfg.telegram;
        if (!t.installed) return { ok: false, error: "Telegram is not installed. The owner (or you, with their PIN) can install it from the plugins screen." };
        if (!t.enabled || !t.botToken) return { ok: false, error: "Telegram is not switched on. The owner finishes setting it up in Plugins, Telegram, Configure." };
        const target = to === "me" || to === "owner" ? t.ownerChatId : /^-?\d{3,15}$/.test(to) ? Number(to) : null;
        if (target === null) return { ok: false, error: to === "me" || to === "owner" ? "Telegram is not linked to the owner yet." : "A Telegram recipient is a chat number, or \"me\"." };
        await this.sendRaw("telegram", String(target), body);
        return { ok: true, summary: `Sent on Telegram${to === "me" || to === "owner" ? " to the owner" : ""}.` };
      }
      const w = this.cfg.twilio;
      if (!w.installed) return { ok: false, error: `${CHANNEL_LABEL[channel]} is not installed. The owner (or you, with their PIN) can install "WhatsApp and SMS (Twilio)" from the plugins screen.` };
      if (!w.enabled || !w.authToken || !w.accountSid) return { ok: false, error: `${CHANNEL_LABEL[channel]} is not switched on. The owner finishes setting it up in Plugins, WhatsApp and SMS, Configure.` };
      const number = to === "me" || to === "owner" ? w.ownerNumber : phoneNumber(to);
      if (!number) return { ok: false, error: "A phone number is needed, in international form such as +919800000000." };
      await this.sendRaw(channel, number, body);
      this.deps.audit.log("agent", "channel.message_out", { channel });
      return { ok: true, summary: `Sent by ${CHANNEL_LABEL[channel]} to ${number}.` };
    } catch (e) {
      return { ok: false, error: this.mask((e as Error).message).slice(0, 200) };
    }
  }

  /** Sends a file from the PC to the owner's chat. Only the owner's own chat or number: never someone else. */
  async sendFile(channel: ChannelId, to: string, file: SendableFile, caption?: string): Promise<SendResult> {
    if (to !== "me" && to !== "owner") return { ok: false, error: "A file can only be sent to the owner." };
    if (channel === "sms") return { ok: false, error: "SMS cannot carry files. Use Telegram or WhatsApp." };
    const text = caption?.trim() ?? "";
    try {
      if (channel === "telegram") {
        const t = this.cfg.telegram;
        if (!t.installed) return { ok: false, error: "Telegram is not installed. The owner can install it from the plugins screen." };
        if (!t.enabled || !t.botToken) return { ok: false, error: "Telegram is not switched on. The owner finishes setting it up in Plugins, Telegram, Configure." };
        if (t.ownerChatId === null) return { ok: false, error: "Telegram is not linked to the owner yet." };
        if (file.size > TELEGRAM_FILE_MAX) return { ok: false, error: "That file is too big for Telegram (50 MB at most)." };
        const photo = file.kind === "image" && /^image\/(jpeg|png|webp)$/.test(file.mime) && file.size <= TELEGRAM_PHOTO_MAX;
        const [method, field] = photo ? (["sendPhoto", "photo"] as const) : file.kind === "audio" ? (["sendAudio", "audio"] as const) : file.kind === "video" && file.mime === "video/mp4" ? (["sendVideo", "video"] as const) : (["sendDocument", "document"] as const);
        const form = new FormData();
        form.set("chat_id", String(t.ownerChatId));
        if (text) form.set("caption", text.slice(0, TELEGRAM_CAPTION));
        form.set(field, new Blob([new Uint8Array(await fsp.readFile(file.path))], { type: file.mime }), file.name);
        const res = await this.f(`https://api.telegram.org/bot${t.botToken}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
        if (!json.ok) throw new Error(json.description ?? `Telegram answered ${res.status}`);
        this.record("telegram", "out", String(t.ownerChatId), "", `[file: ${file.name}]${text ? " " + text : ""}`);
        this.deps.audit.log("agent", "channel.file_out", { channel, kind: file.kind });
        return { ok: true, summary: "Sent the file on Telegram to the owner." };
      }
      const w = this.cfg.twilio;
      if (!w.installed) return { ok: false, error: "WhatsApp is not installed. The owner can install \"WhatsApp and SMS (Twilio)\" from the plugins screen." };
      if (!w.enabled || !w.authToken || !w.accountSid) return { ok: false, error: "WhatsApp is not switched on. The owner finishes setting it up in Plugins, WhatsApp and SMS, Configure." };
      if (!w.ownerNumber) return { ok: false, error: "A phone number is needed, in international form such as +919800000000." };
      if (file.size > WHATSAPP_FILE_MAX) return { ok: false, error: "That file is too big for WhatsApp (16 MB at most)." };
      const base = this.deps.publicBase?.()?.replace(/\/+$/, "");
      if (!base) return { ok: false, error: "WhatsApp fetches files from Friend, so Friend needs its public address first (Settings, or the tunnel)." };
      const token = this.stash(file);
      await this.twilioSend(w.ownerNumber, text, true, `${base}/api/channels/media/${token}`);
      this.record("whatsapp", "out", w.ownerNumber, "", `[file: ${file.name}]${text ? " " + text : ""}`);
      this.deps.audit.log("agent", "channel.file_out", { channel, kind: file.kind });
      return { ok: true, summary: `Sent the file by WhatsApp to ${w.ownerNumber}.` };
    } catch (e) {
      return { ok: false, error: this.mask((e as Error).message).slice(0, 200) };
    }
  }

  private stash(file: SendableFile): string {
    const now = this.now();
    for (const [k, v] of this.outbox) if (v.expires <= now) this.outbox.delete(k);
    while (this.outbox.size >= OUTBOX_MAX) this.outbox.delete(this.outbox.keys().next().value as string);
    const token = randomBytes(16).toString("hex");
    this.outbox.set(token, { path: file.path, mime: file.mime, name: file.name, expires: now + OUTBOX_TTL_MS });
    return token;
  }

  /** The file behind a token Friend gave Twilio, while it is still good. */
  mediaFor(token: string): { path: string; mime: string; name: string } | null {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const f = this.outbox.get(token);
    if (!f) return null;
    if (f.expires <= this.now()) {
      this.outbox.delete(token);
      return null;
    }
    return { path: f.path, mime: f.mime, name: f.name };
  }

  // ---- twilio (SMS and WhatsApp) -------------------------------------------------------------------------------

  private async twilioSend(to: string, text: string, whatsapp: boolean, mediaUrl?: string): Promise<void> {
    const w = this.cfg.twilio;
    if (!w.accountSid || !w.authToken) throw new Error("Twilio is not set up.");
    const from = whatsapp ? w.whatsappFrom : w.smsFrom;
    if (!from) throw new Error(`No ${whatsapp ? "WhatsApp" : "SMS"} number is set.`);
    const prefix = whatsapp ? "whatsapp:" : "";
    const body = new URLSearchParams({ To: `${prefix}${to}`, From: `${prefix}${from}` });
    if (text) body.set("Body", text.slice(0, SMS_MAX));
    if (mediaUrl) body.set("MediaUrl", mediaUrl);
    const res = await this.f(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(w.accountSid)}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${w.accountSid}:${w.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(`Twilio: ${j.message ?? res.status}`);
    }
  }

  /** What Twilio signs: the full address, then every form field name and value in name order. */
  static twilioSignature(token: string, url: string, params: Record<string, string>): string {
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
    return createHmac("sha1", token).update(data).digest("base64");
  }

  /** A message arrived from Twilio. Returns "forbidden" for a wrong signature, "off" when Twilio is not switched on. */
  handleTwilio(url: string, params: Record<string, string>, signature: string | undefined): "ok" | "forbidden" | "off" {
    const w = this.cfg.twilio;
    if (!w.installed || !w.enabled || !w.authToken) return "off";
    const expected = Buffer.from(ChannelHub.twilioSignature(w.authToken, url, params));
    const given = Buffer.from(signature ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      this.deps.audit.log("system", "channel.twilio_refused", {});
      return "forbidden";
    }
    const sid = params.MessageSid;
    if (sid) {
      if (this.seen.includes(sid)) return "ok"; // Twilio tries again when it is slow: never run one message twice
      this.seen.push(sid);
      if (this.seen.length > 200) this.seen.shift();
    }
    const from = params.From ?? "";
    const whatsapp = from.startsWith("whatsapp:");
    const channel: ChannelId = whatsapp ? "whatsapp" : "sms";
    const number = from.replace(/^whatsapp:/, "");
    const text = (params.Body ?? "").trim().slice(0, 1600);
    const isOwner = !!w.ownerNumber && digits(number) === digits(w.ownerNumber);
    if (!text) {
      // a voice message: understood and answered like a typed one, for the owner only
      const mediaUrl = params.MediaUrl0;
      const mediaType = params.MediaContentType0 ?? "";
      if (!isOwner || !mediaUrl || !(Number(params.NumMedia) > 0) || !/^audio\//i.test(mediaType)) return "ok";
      if (!this.allowed(`owner:${channel}`, OWNER_LIMIT)) return "ok";
      void this.answerVoice(channel, number, () => this.twilioAudio(mediaUrl, mediaType)).catch((e) => this.deps.audit.log("system", "channel.respond_failed", { message: (e as Error).message.slice(0, 200) }));
      return "ok";
    }
    if (isOwner) {
      if (!this.allowed(`owner:${channel}`, OWNER_LIMIT)) return "ok";
      void this.respond(channel, number, text).catch((e) => this.deps.audit.log("system", "channel.respond_failed", { message: (e as Error).message.slice(0, 200) }));
      return "ok";
    }
    if (!this.allowed(`stranger:${channel}:${digits(number)}`, STRANGER_LIMIT)) return "ok";
    this.record(channel, "in", number, plain(number), text);
    this.deps.audit.log("system", "channel.message_in", { channel, via: "contact" });
    this.deps.notify({ type: "alert", level: "info", text: `New ${CHANNEL_LABEL[channel]} message from ${plain(number)}: ${clip(plain(text), 80)}` });
    return "ok";
  }
}
