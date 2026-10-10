import { PresenceStyle, ViewPreset } from "@friend/protocol";
import { z } from "zod";
import type { Config } from "./config";
import { phoneNumber, sanitizeLook, sanitizeVoice } from "./config";

const word = /^[\w.:/\\-]+$/;
const modelName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][\w.:/-]*$/, "A model name has no spaces");

/** Everything the owner may change from the screen. Network, folders and safety rules stay in the terminal on purpose. */
export const SettingsPatch = z
  .object({
    provider: z.enum(["claude", "claude-code", "ollama", "openai"]),
    model: modelName,
    /** Empty means "leave the saved key alone". */
    apiKey: z.string().trim().max(400),
    view: ViewPreset,
    /** What the profile badge calls the owner. Empty clears it. */
    ownerName: z.string().trim().max(40),
    /** How much Friend asks before acting. Loosening it is a change that needs the PIN. */
    approvals: z.enum(["manual", "edits", "auto"]),
    /** Telegram, SMS and WhatsApp. Empty tokens mean "leave the saved one alone". Needs the PIN. */
    channels: z
      .object({
        telegram: z
          .object({
            enabled: z.boolean(),
            botToken: z.string().trim().max(200).regex(/^(\d{6,12}:[A-Za-z0-9_-]{20,})?$/, "A bot token from @BotFather looks like 123456789:ABC..."),
          })
          .partial()
          .strict(),
        twilio: z
          .object({
            enabled: z.boolean(),
            accountSid: z.string().trim().max(64).regex(/^(AC[0-9a-fA-F]{20,})?$/, "A Twilio account SID starts with AC"),
            authToken: z.string().trim().max(200),
            smsFrom: z.string().trim().max(30).regex(/^(\+?[0-9 ()-]{6,20})?$/, "A phone number in international form such as +14155550123, or empty"),
            whatsappFrom: z.string().trim().max(30).regex(/^(\+?[0-9 ()-]{6,20})?$/, "A phone number in international form such as +14155550123, or empty"),
            ownerNumber: z.string().trim().max(30).regex(/^(\+?[0-9 ()-]{6,20})?$/, "Your own phone number in international form such as +919800000000, or empty"),
          })
          .partial()
          .strict(),
      })
      .partial()
      .strict(),
    look: z
      .object({
        style: PresenceStyle,
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour like #3fd8ff"),
        intensity: z.number().min(0).max(1),
        size: z.number().min(0.5).max(1.5),
        reactivity: z.number().min(0).max(1),
        ambient: z.boolean(),
        captions: z.boolean(),
        captionSize: z.enum(["small", "medium", "large"]),
        aiMayChange: z.boolean(),
      })
      .partial()
      .strict(),
    ollama: z
      .object({
        url: z.string().trim().max(200),
        model: z.string().trim().min(1).max(100),
        vision: z.boolean(),
        contextTokens: z.number().int().min(1024).max(131072),
      })
      .partial()
      .strict(),
    openai: z
      .object({
        url: z.string().trim().max(300),
        model: modelName,
        /** Empty means "leave the saved key alone". */
        apiKey: z.string().trim().max(400),
        vision: z.boolean(),
      })
      .partial()
      .strict(),
    claudeCode: z
      .object({
        model: modelName,
        command: z.string().trim().min(1).max(260).regex(word, "The command is one word or path without spaces"),
        fallback: z.enum(["ollama", "none"]),
      })
      .partial()
      .strict(),
    voice: z
      .object({
        enabled: z.boolean(),
        speakTyped: z.boolean(),
        language: z.string().trim().max(10).regex(/^([a-z]{2,3}(-[A-Za-z]{2,4})?)?$/, "Use a language code such as en or hi, or leave it empty"),
        accept: z.number().min(0).max(1),
        challenge: z.number().min(0).max(1),
        ttsVoice: z.string().trim().min(1).max(80).regex(/^[\w.-]+$/),
        /** A Piper voice name; empty makes the main voice read Hindi too. */
        hindiVoice: z.string().trim().max(80).regex(/^[A-Za-z0-9_-]*$/, "A Piper voice name such as hi_IN-priyamvada-medium, or empty"),
        marathiVoice: z.string().trim().max(80).regex(/^[A-Za-z0-9_-]*$/, "A Piper voice name such as mr_IN-google-medium, or empty"),
        sttModel: z.string().trim().min(1).max(80).regex(/^[\w./-]+$/),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export interface SettingsView {
  provider: Config["provider"];
  model: string;
  /** The key itself is never sent to the screen. */
  apiKeySet: boolean;
  view: Config["view"];
  ownerName: string;
  approvals: Config["approvals"];
  /** The tokens themselves are never sent to the screen. */
  channels: {
    telegram: { enabled: boolean; tokenSet: boolean; linked: boolean };
    twilio: { enabled: boolean; accountSid: string; tokenSet: boolean; smsFrom: string; whatsappFrom: string; ownerNumber: string };
  };
  look: Config["look"];
  ollama: { url: string; model: string; vision: boolean; contextTokens: number };
  /** The key itself is never sent to the screen. */
  openai: { url: string; model: string; vision: boolean; apiKeySet: boolean };
  claudeCode: Config["claudeCode"];
  voice: Pick<Config["voice"], "enabled" | "speakTyped" | "language" | "accept" | "challenge" | "ttsVoice" | "sttModel" | "hindiVoice" | "marathiVoice">;
}

export function settingsView(c: Config): SettingsView {
  return {
    provider: c.provider,
    model: c.model,
    apiKeySet: !!c.apiKey,
    view: c.view,
    ownerName: c.ownerName,
    approvals: c.approvals,
    channels: {
      telegram: { enabled: c.channels.telegram.enabled, tokenSet: !!c.channels.telegram.botToken, linked: c.channels.telegram.ownerChatId !== null },
      twilio: { enabled: c.channels.twilio.enabled, accountSid: c.channels.twilio.accountSid, tokenSet: !!c.channels.twilio.authToken, smsFrom: c.channels.twilio.smsFrom, whatsappFrom: c.channels.twilio.whatsappFrom, ownerNumber: c.channels.twilio.ownerNumber },
    },
    look: { ...c.look },
    ollama: { url: c.ollama.url, model: c.ollama.model, vision: !!c.ollama.vision, contextTokens: c.ollama.contextTokens },
    openai: { url: c.openai.url, model: c.openai.model, vision: !!c.openai.vision, apiKeySet: !!c.openai.apiKey },
    claudeCode: { ...c.claudeCode },
    voice: {
      enabled: c.voice.enabled,
      speakTyped: c.voice.speakTyped,
      language: c.voice.language,
      accept: c.voice.accept,
      challenge: c.voice.challenge,
      ttsVoice: c.voice.ttsVoice,
      sttModel: c.voice.sttModel,
      hindiVoice: c.voice.hindiVoice,
      marathiVoice: c.voice.marathiVoice,
    },
  };
}

export class SettingsError extends Error {}

/** What the AI may not change even with the owner's PIN: the key, and the program that gets started. Those stay on the screen. */
export function refuseForAgent(raw: unknown): void {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cc = (r.claudeCode && typeof r.claudeCode === "object" ? r.claudeCode : {}) as Record<string, unknown>;
  const oa = (r.openai && typeof r.openai === "object" ? r.openai : {}) as Record<string, unknown>;
  if ("channels" in r) throw new SettingsError("Messaging channels can only be set up by the owner on the settings screen.");
  if ("approvals" in r) throw new SettingsError("How much Friend asks before acting can only be changed by the owner on the settings screen.");
  if ("apiKey" in r || "apiKey" in oa) throw new SettingsError("The API key can only be changed by the owner on the settings screen.");
  if ("command" in cc) throw new SettingsError("The Claude Code command can only be changed by the owner on the settings screen.");
}

export interface Applied {
  /** Names of the settings that were given (never values: some are secrets). */
  changed: string[];
  /** The model backend has to be rebuilt. */
  providerChanged: boolean;
  /** Settings that only take effect after Friend restarts. */
  restart: string[];
}

const PROVIDER_KEYS = new Set(["provider", "model", "apiKey", "ollama", "openai", "claudeCode"]);
const RESTART_VOICE = ["enabled", "sttModel"];

/** Checks the patch against the current config and applies it in place. Nothing changes when it is refused. */
export function applySettings(config: Config, raw: unknown): Applied {
  const parsed = SettingsPatch.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SettingsError(issue ? `${issue.path.join(".") || "settings"}: ${issue.message}` : "Invalid settings");
  }
  const p = parsed.data;

  const ollamaUrl = p.ollama?.url;
  if (ollamaUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(ollamaUrl);
    } catch {
      throw new SettingsError("ollama.url: Expected a URL such as http://127.0.0.1:11434");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new SettingsError("ollama.url: The URL must start with http:// or https://");
    p.ollama!.url = u.origin;
  }

  const openaiUrl = p.openai?.url;
  if (openaiUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(openaiUrl);
    } catch {
      throw new SettingsError("openai.url: Expected a URL such as http://localhost:20128/v1");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new SettingsError("openai.url: The URL must start with http:// or https://");
    p.openai!.url = (u.origin + u.pathname).replace(/\/+$/, ""); // keeps the path (/v1), drops a trailing slash, query and fragment
  }

  const next = {
    provider: p.provider ?? config.provider,
    apiKey: p.apiKey ? p.apiKey : config.apiKey,
    voice: sanitizeVoice({
      ...config.voice,
      ...(p.voice ?? {}),
      language: p.voice && "language" in p.voice ? p.voice.language || null : config.voice.language,
    } as Config["voice"]),
  };
  if (p.provider === "claude" && !next.apiKey) throw new SettingsError("Enter an API key to use Claude, or choose Claude Code or Ollama.");
  if (p.voice && (p.voice.accept !== undefined || p.voice.challenge !== undefined)) {
    const accept = p.voice.accept ?? config.voice.accept;
    const challenge = p.voice.challenge ?? config.voice.challenge;
    if (challenge > accept) throw new SettingsError("voice: The \"ask for PIN\" level cannot be above the \"it is me\" level.");
  }

  const restart = Object.keys(p.voice ?? {}).filter((k) => RESTART_VOICE.includes(k) && (p.voice as Record<string, unknown>)[k] !== (config.voice as unknown as Record<string, unknown>)[k]).map((k) => `voice.${k}`);

  config.provider = next.provider;
  if (p.view) config.view = p.view;
  if (p.approvals) config.approvals = p.approvals;
  if (p.channels) {
    const { telegram, twilio } = p.channels;
    if (telegram) {
      if (telegram.enabled !== undefined) config.channels.telegram.enabled = telegram.enabled;
      if (telegram.botToken) config.channels.telegram.botToken = telegram.botToken;
    }
    if (twilio) {
      const t = config.channels.twilio;
      if (twilio.enabled !== undefined) t.enabled = twilio.enabled;
      if (twilio.accountSid !== undefined) t.accountSid = twilio.accountSid;
      if (twilio.authToken) t.authToken = twilio.authToken;
      if (twilio.smsFrom !== undefined) t.smsFrom = phoneNumber(twilio.smsFrom);
      if (twilio.whatsappFrom !== undefined) t.whatsappFrom = phoneNumber(twilio.whatsappFrom);
      if (twilio.ownerNumber !== undefined) t.ownerNumber = phoneNumber(twilio.ownerNumber);
    }
  }
  if (p.ownerName !== undefined) config.ownerName = p.ownerName.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (p.look) config.look = sanitizeLook({ ...config.look, ...p.look });
  if (p.model) config.model = p.model;
  if (p.apiKey) config.apiKey = p.apiKey;
  if (p.ollama) Object.assign(config.ollama, p.ollama);
  if (p.openai) {
    const { apiKey, ...rest } = p.openai;
    Object.assign(config.openai, rest);
    if (apiKey) config.openai.apiKey = apiKey;
  }
  if (p.claudeCode) Object.assign(config.claudeCode, p.claudeCode);
  if (p.voice) {
    const safe = next.voice;
    for (const k of Object.keys(p.voice) as (keyof Config["voice"])[]) (config.voice as unknown as Record<string, unknown>)[k] = safe[k];
  }

  const changed = Object.entries(p).flatMap(([k, v]) => (v && typeof v === "object" ? Object.keys(v).map((f) => `${k}.${f}`) : [k]));
  return { changed, providerChanged: changed.some((k) => PROVIDER_KEYS.has(k.split(".")[0]!)), restart };
}

/** Settings that only change how the screen looks. They need no PIN, because nothing about safety depends on them. */
export const COSMETIC_KEYS = new Set(["view", "look", "ownerName"]);

/** The part of the look that only the screen needs; the style, colour and glow travel as stage state. */
export function clientLook(l: Config["look"]) {
  return { size: l.size, reactivity: l.reactivity, ambient: l.ambient, captions: l.captions, captionSize: l.captionSize };
}
