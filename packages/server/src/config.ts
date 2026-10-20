import { normalizeSites, VIDEO_LIMITS, VIDEO_OUTPUTS, VIDEO_YOUTUBE, type VideoOutput, type VideoYoutube } from "@friend/protocol";
import { AUDIO_EXTENSIONS, DEFAULT_SOURCES, type DefaultSource, launcherProblem, MUSIC_OUTPUTS, type MusicOutput, programProblem, MAX_LAUNCHER, MUSIC_LIMITS, REPEAT_MODES, type LauncherItem, type RepeatMode } from "@friend/protocol";
import { HUD_DENSITIES, HUD_LAYOUTS, HUD_WIDGET_IDS, type HudDensity, type HudLayout, type HudWidgetId } from "@friend/protocol";
import { OfficePolicy, OfficeProject, OfficeRole } from "@friend/protocol";
import { ALEXA_LIMITS, ALEXA_LOCALES, isNeverByVoice, TOOL_NAME, type AlexaLocale } from "./alexa/constants";
import { invocationNameProblem } from "./alexa/invocation";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_HINDI_VOICE, DEFAULT_MARATHI_VOICE, type PresenceStyle, type ViewPreset } from "@friend/protocol";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

export interface Config {
  bind: string;
  port: number;
  publicUrl: string | null;
  /** Serve https:// with a certificate Friend makes for itself, so a phone on the network is allowed to use the microphone. */
  https: boolean;
  trustProxy: boolean;
  allowedOrigins: string[];
  /** Extra hostnames accepted in the Host header (besides localhost, IP literals and the publicUrl host). */
  allowedHosts: string[];
  roots: string[];
  destructivePatterns: string[];
  model: string;
  apiKey: string | null;
  /** Which model backend answers: Claude (needs an API key) or a local Ollama server. */
  provider: ProviderName;
  ollama: OllamaConfig;
  /** Any server that speaks the OpenAI chat API, such as OmniRoute, LM Studio or OpenRouter. */
  openai: OpenAiConfig;
  claudeCode: ClaudeCodeConfig;
  voice: VoiceConfig;
  /** Updating Friend: by itself, or only when the owner says so. */
  updates: UpdatesConfig;
  session: SessionConfig;
  web: WebConfig;
  /** What the screen shows besides the AI's pictures: minimal, companion (status line and clock) or workspace (also chat and schedule). */
  view: ViewPreset;
  look: LookConfig;
  /** What the profile badge on the screen calls the owner. Empty shows "Owner". */
  ownerName: string;
  /** How much Friend asks before acting: manual (asks), edits (files and sandboxed code go ahead) or auto (everything but risky things goes ahead). */
  approvals: ApprovalMode;
  /** Messaging channels: Telegram, and SMS and WhatsApp through Twilio. The tokens are secrets and never go to the screen. */
  channels: ChannelsConfig;
  /** Stock brokers the owner can read their account from (Zerodha first). */
  brokers: BrokersConfig;
  /** What the assistant may do with money. Only "read" exists in this version. */
  trading: TradingConfig;
  /** The owner's own Alexa skill (custom, in development) and which Amazon accounts may use it. */
  alexa: AlexaConfig;
  /** The music player: where the owner's music is, and how the player starts. */
  music: MusicConfig;
  /** Chrome control, the plugin that lets Friend use the owner's own Chrome (it comes with Friend). Only the owner changes it. */
  chrome: ChromeConfig;
  /** Playing videos from the internet (YouTube and other sites), on the screen or in a PC window. */
  video: VideoConfig;
  /** The screen widgets: profile label, date and time, quick-launch buttons, animations. */
  hud: HudConfig;
  /** The Office: workers Friend hires, in the owner's projects, under the owner's rules. */
  office: OfficeConfig;
  dataDir: string;
}

export interface VideoConfig {
  installed: boolean;
  enabled: boolean;
  /** Where a video plays by default: the Friend screen, or a window on the PC. */
  output: VideoOutput;
  maxHeight: number;
  maxMinutes: number;
  /** Only these sites (and their sub-domains) may be played; empty means any public site. */
  allowedSites: string[];
  /** The yt-dlp and ffmpeg programs the owner chose (a name or a path); empty means find them. */
  ytdlp: string;
  ffmpeg: string;
  /** Friend downloads yt-dlp and ffmpeg itself when they are missing (from the projects' own release pages, checked), so nothing is installed by hand. */
  autoInstall: boolean;
  /** How a YouTube video plays on the screen: in YouTube's own player (embed), or made by Friend (stream). */
  youtube: VideoYoutube;
}

export interface ChromeConfig {
  installed: boolean;
  enabled: boolean;
  /** Chrome control may also be reached from other PCs on Friend's own address (/chrome/mcp, /chrome/ws), with its key. Off unless the owner switches it on. */
  remote: boolean;
}

export interface MusicConfig {
  /** The folder the music is in (empty: the player is off until the owner chooses one). */
  folder: string;
  /** Which audio kinds to look for. */
  extensions: string[];
  /** How many tracks to list at most, and how many levels of sub-folders to look into. */
  maxTracks: number;
  scanDepth: number;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  /** The moving bars (off saves power on weak devices). */
  visualizer: boolean;
  startView: "mini" | "full";
  /** Where a search or a play starts from when the assistant names no source. */
  defaultSource: DefaultSource;
  /** How many results a search from a connected service returns at most. */
  searchLimit: number;
  /** Where the sound comes out: the screen's browser, or the PC that runs Friend (needs mpv, and for Spotify a Spotify device). */
  output: MusicOutput;
  /** The program that plays the folder's music on the PC (mpv): a name or a path. Empty: find it automatically. */
  hostPlayer: string;
  /** The name of the Spotify device on the PC to play on, when the output is the PC. */
  spotifyDevice: string;
  /** The Spotify plugin: added from the plugins screen. The client id is the owner's own free developer app (not secret); tokens are never kept here. */
  spotify: { installed: boolean; enabled: boolean; clientId: string };
  soundcloud: { installed: boolean; enabled: boolean; clientId: string };
  audius: { installed: boolean; enabled: boolean };
}

export interface HudConfig {
  /** The word after the assistant's name on the profile tag ("JARVIS TERMINAL"). */
  terminalLabel: string;
  clock: { hour12: boolean; seconds: boolean; /** A locale for the date ("en-GB"); empty uses the browser's. */ locale: string };
  launcher: LauncherItem[];
  /** full: every animation; reduced: only the gentle ones; off: none. The system's "reduce motion" always wins. */
  animations: "full" | "reduced" | "off";
  /** classic: the orb with floating cards. orbital: the HUD with rings, an orbit and edge instruments. */
  layout: HudLayout;
  /** How much the orbital screen shows. */
  density: HudDensity;
  /** Instruments switched on or off by hand; a missing one follows the density. */
  widgets: Partial<Record<HudWidgetId, boolean>>;
  /** Show sample content in the orbital screen (to preview the look before workers exist); it is labelled as sample. */
  preview: boolean;
}

export interface AlexaConfig {
  /** The skill's name in the Alexa console and its store listing (not what is said to start it). */
  skillName: string;
  /** The languages the skill package is made for. */
  locales: AlexaLocale[];
  /** How long Friend works on an open question before saying "still working", seconds (Alexa itself gives up after 8). */
  answerSeconds: number;
  /** How long a late answer is kept for "is it ready", minutes. */
  holdMinutes: number;
  /** How long the owner has to answer a permission message, seconds. */
  permissionSeconds: number;
  /** How many requests a minute the endpoint accepts from one address, and how many Echo accounts may be allowed. */
  requestsPerMinute: number;
  maxDevices: number;
  /** Extra tools a voice may use without asking (never PC, file, settings, add-on, camera or PIN tools). */
  extraVoiceTools: string[];
  /** `installed`: added from the plugins screen (or set up earlier). `enabled`: switched on. */
  installed: boolean;
  enabled: boolean;
  /** The skill's id from the Alexa developer console (amzn1.ask.skill...). Not a secret. */
  skillId: string;
  /** What the owner says after "Alexa, ask": lower-case words (one word is fine in development mode). */
  invocationName: string;
  /** Amazon accounts allowed to talk to Friend through Alexa. */
  allowedUsers: { id: string; name: string; addedAt: number }[];
}

const SKILL_ID = /^amzn1\.ask\.skill\.[A-Za-z0-9-]{8,80}$/;
const AMAZON_USER = /^amzn1\.ask\.account\.[A-Za-z0-9._-]{8,500}$/;

export const DEFAULT_MUSIC: MusicConfig = { folder: "", extensions: [...AUDIO_EXTENSIONS], maxTracks: MUSIC_LIMITS.maxTracks.def, scanDepth: MUSIC_LIMITS.scanDepth.def, volume: MUSIC_LIMITS.volume.def, shuffle: false, repeat: "all", visualizer: true, startView: "mini", defaultSource: "local", searchLimit: MUSIC_LIMITS.searchLimit.def, output: "screen", hostPlayer: "", spotifyDevice: "", spotify: { installed: false, enabled: false, clientId: "" }, soundcloud: { installed: false, enabled: false, clientId: "" }, audius: { installed: false, enabled: false } };

const CLIENT_ID = /^[A-Za-z0-9]{8,64}$/;

function sanitizeSpotify(raw: unknown): MusicConfig["spotify"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = typeof r.clientId === "string" ? r.clientId.trim() : "";
  const clientId = CLIENT_ID.test(id) ? id : "";
  return { installed: r.installed === true || (r.installed === undefined && (r.enabled === true || clientId !== "")), enabled: r.enabled === true, clientId };
}

export function sanitizeVideo(raw: unknown): VideoConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, o: { min: number; max: number; def: number }): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(o.max, Math.max(o.min, Math.round(v))) : o.def);
  const program = (v: unknown): string => (typeof v === "string" && programProblem(v.trim()) === null ? v.trim() : "");
  return {
    installed: r.installed === true || (r.installed === undefined && r.enabled === true),
    enabled: r.enabled === true,
    output: (VIDEO_OUTPUTS as readonly unknown[]).includes(r.output) ? (r.output as VideoOutput) : "screen",
    maxHeight: num(r.maxHeight, VIDEO_LIMITS.maxHeight),
    maxMinutes: num(r.maxMinutes, VIDEO_LIMITS.maxMinutes),
    allowedSites: normalizeSites(r.allowedSites),
    ytdlp: program(r.ytdlp),
    ffmpeg: program(r.ffmpeg),
    autoInstall: r.autoInstall !== false,
    youtube: (VIDEO_YOUTUBE as readonly unknown[]).includes(r.youtube) ? (r.youtube as VideoYoutube) : "embed",
  };
}

export function sanitizeChrome(raw: unknown): ChromeConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { installed: r.installed === true || (r.installed === undefined && r.enabled === true), enabled: r.enabled === true, remote: r.remote === true };
}

function sanitizeAudius(raw: unknown): MusicConfig["audius"] {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { installed: r.installed === true || (r.installed === undefined && r.enabled === true), enabled: r.enabled === true };
}

export function sanitizeMusic(raw: unknown): MusicConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, o: { min: number; max: number; def: number }): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(o.max, Math.max(o.min, Math.round(v))) : o.def);
  const exts = [...new Set((Array.isArray(r.extensions) ? r.extensions : []).map((e) => (typeof e === "string" ? e.toLowerCase().replace(/^\./, "") : "")).filter((e) => (AUDIO_EXTENSIONS as readonly string[]).includes(e)))];
  return {
    folder: typeof r.folder === "string" ? r.folder.trim().slice(0, 500) : "",
    extensions: exts.length ? exts : [...AUDIO_EXTENSIONS],
    maxTracks: num(r.maxTracks, MUSIC_LIMITS.maxTracks),
    scanDepth: num(r.scanDepth, MUSIC_LIMITS.scanDepth),
    volume: num(r.volume, MUSIC_LIMITS.volume),
    shuffle: r.shuffle === true,
    repeat: (REPEAT_MODES as readonly unknown[]).includes(r.repeat) ? (r.repeat as RepeatMode) : "all",
    visualizer: r.visualizer !== false,
    startView: r.startView === "full" ? "full" : "mini",
    defaultSource: (DEFAULT_SOURCES as readonly unknown[]).includes(r.defaultSource) ? (r.defaultSource as DefaultSource) : "local",
    searchLimit: num(r.searchLimit, MUSIC_LIMITS.searchLimit),
    output: (MUSIC_OUTPUTS as readonly unknown[]).includes(r.output) ? (r.output as MusicOutput) : "screen",
    hostPlayer: typeof r.hostPlayer === "string" && programProblem(r.hostPlayer.trim()) === null ? r.hostPlayer.trim() : "",
    spotifyDevice: typeof r.spotifyDevice === "string" ? r.spotifyDevice.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) : "",
    spotify: sanitizeSpotify(r.spotify),
    soundcloud: sanitizeSpotify(r.soundcloud),
    audius: sanitizeAudius(r.audius),
  };
}

const DEFAULT_LAUNCHER: LauncherItem[] = [
  { id: "chat", label: "Chat", icon: "💬", action: { type: "panel", value: "chat" } },
  { id: "tasks", label: "Tasks", icon: "✅", action: { type: "panel", value: "tasks" } },
  { id: "music", label: "Music", icon: "🎵", action: { type: "panel", value: "music" } },
  { id: "plugins", label: "Plugins", icon: "🧩", action: { type: "panel", value: "plugins" } },
  { id: "settings", label: "Settings", icon: "⚙", action: { type: "panel", value: "settings" } },
];

/** Whether a date locale is one this PC knows. */
export const validDateLocale = (l: unknown): l is string => {
  if (typeof l !== "string" || !l || l.length > 35) return false;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([l]).length === 1;
  } catch {
    return false;
  }
};

const sanitizeWidgets = (raw: unknown): Partial<Record<HudWidgetId, boolean>> => {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<Record<HudWidgetId, boolean>> = {};
  for (const id of HUD_WIDGET_IDS) if (typeof r[id] === "boolean") out[id] = r[id] as boolean;
  return out;
};

export function sanitizeHud(raw: unknown): HudConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (r.clock && typeof r.clock === "object" ? r.clock : {}) as Record<string, unknown>;
  const stored = Array.isArray(r.launcher) ? r.launcher : null;
  const seen = new Set<string>();
  const launcher = (stored ?? DEFAULT_LAUNCHER).flatMap((item, i): LauncherItem[] => {
    if (launcherProblem(item) !== null) return [];
    const x = item as { id?: unknown; label: string; icon: string; action: { type: LauncherItem["action"]["type"]; value: string } };
    let id = typeof x.id === "string" && /^[a-z0-9-]{1,20}$/.test(x.id) ? x.id : `b${i + 1}`;
    while (seen.has(id)) id = `${id}x`;
    seen.add(id);
    return [{ id, label: x.label.trim(), icon: x.icon.trim(), action: { type: x.action.type, value: x.action.value.trim() } }];
  });
  return {
    terminalLabel: (typeof r.terminalLabel === "string" ? r.terminalLabel.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 24) : "") || "TERMINAL",
    clock: { hour12: c.hour12 !== false, seconds: c.seconds === true, locale: validDateLocale(c.locale) ? c.locale : "" },
    launcher: launcher.slice(0, MAX_LAUNCHER),
    animations: r.animations === "reduced" || r.animations === "off" ? r.animations : "full",
    layout: (HUD_LAYOUTS as readonly unknown[]).includes(r.layout) ? (r.layout as HudLayout) : "classic",
    density: (HUD_DENSITIES as readonly unknown[]).includes(r.density) ? (r.density as HudDensity) : "standard",
    widgets: sanitizeWidgets(r.widgets),
    preview: r.preview === true,
  };
}

/** Everything about the Office is a setting. Nothing in code names a role, a model, a folder or a limit. */
export interface OfficeConfig {
  enabled: boolean;
  /** How many workers run at the same time (the rest wait their turn). */
  maxConcurrent: number;
  /** A worker that says nothing for this long after it starts is stopped, seconds. */
  startTimeoutSec: number;
  /** New runs wait while the five-hour window is this full (0..1); 0 never waits. */
  pauseAtWindow: number;
  /** Tokens a worker may use, and all workers together; 0 means no limit. */
  budget: { perWorkerTokens: number; totalTokens: number };
  roles: OfficeRole[];
  projects: OfficeProject[];
  policy: OfficePolicy;
}

/** Starter data, not rules: the owner edits, replaces or deletes all of it, and a saved empty list stays empty. */
export const DEFAULT_OFFICE_ROLES: OfficeRole[] = [
  { id: "builder", title: "Builder", instructions: "You build what the ticket asks for, in small, tested steps. Say plainly what you changed.", model: "", permission: "acceptEdits" },
  { id: "tester", title: "Tester", instructions: "You test the project: write or run tests, find what breaks, and report it. Do not change production code.", model: "", permission: "default" },
  { id: "reviewer", title: "Reviewer", instructions: "You read the changes and report problems, risks and missing tests. Do not change anything.", model: "", permission: "default" },
];
export const DEFAULT_OFFICE_POLICY: OfficePolicy = {
  allowTools: ["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit"],
  denyCommands: ["rm\\s+-rf\\s+[/~]", "format\\s+[a-z]:", "git\\s+push", "npm\\s+publish", "curl[^|]*\\|\\s*(sh|bash)"],
};

/** A folder written the same way whatever the owner typed: no `..`, no trailing separator. */
function tidyFolder(p: unknown): string {
  if (typeof p !== "string") return "";
  let s = p.trim();
  if (!s) return "";
  const win = /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("\\\\");
  s = (win ? win32 : posix).normalize(s);
  if (s.length > 1 && !(win ? /^[a-zA-Z]:\\$/ : /^\/$/).test(s)) s = s.replace(/[\\/]+$/, "");
  return s.slice(0, 260);
}

export function sanitizeOffice(raw: unknown): OfficeConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, def: number, whole = true): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, whole ? Math.round(v) : Math.round(v * 100) / 100)) : def;
  const b = obj(r.budget);
  const p = obj(r.policy);
  const strings = (v: unknown, def: readonly string[], max: number, maxLen: number): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => s.length > 0 && s.length <= maxLen))].slice(0, max) : [...def];

  const seenRoles = new Set<string>();
  const roles = Array.isArray(r.roles)
    ? r.roles.flatMap((x): OfficeRole[] => {
        const o = obj(x);
        const parsed = OfficeRole.safeParse({ ...o, id: typeof o.id === "string" ? o.id.trim() : o.id, title: typeof o.title === "string" ? o.title.trim() : o.title });
        if (!parsed.success || seenRoles.has(parsed.data.id)) return [];
        seenRoles.add(parsed.data.id);
        return [parsed.data];
      }).slice(0, 20)
    : DEFAULT_OFFICE_ROLES.map((x) => ({ ...x }));

  const seenProjects = new Set<string>();
  const projects = (Array.isArray(r.projects) ? r.projects : []).flatMap((x): OfficeProject[] => {
    const o = obj(x);
    const extra = (Array.isArray(o.extraFolders) ? o.extraFolders : []).map(tidyFolder).filter((f) => f !== "");
    const parsed = OfficeProject.safeParse({ ...o, id: typeof o.id === "string" ? o.id.trim() : o.id, folder: tidyFolder(o.folder), extraFolders: extra.slice(0, 5) });
    if (!parsed.success || seenProjects.has(parsed.data.id)) return [];
    seenProjects.add(parsed.data.id);
    return [parsed.data];
  }).slice(0, 20);

  return {
    enabled: r.enabled === true,
    maxConcurrent: num(r.maxConcurrent, 1, 8, 2),
    startTimeoutSec: num(r.startTimeoutSec, 10, 600, 60),
    pauseAtWindow: num(r.pauseAtWindow, 0, 1, 0.9, false),
    budget: { perWorkerTokens: num(b.perWorkerTokens, 0, 1_000_000_000, 0), totalTokens: num(b.totalTokens, 0, 1_000_000_000, 0) },
    roles,
    projects,
    policy: { allowTools: strings(p.allowTools, DEFAULT_OFFICE_POLICY.allowTools, 40, 60), denyCommands: strings(p.denyCommands, DEFAULT_OFFICE_POLICY.denyCommands, 40, 200) },
  };
}
export function sanitizeAlexa(raw: unknown): AlexaConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const skillId = typeof r.skillId === "string" && SKILL_ID.test(r.skillId.trim()) ? r.skillId.trim() : "";
  const name = typeof r.invocationName === "string" && invocationNameProblem(r.invocationName.trim()) === null ? r.invocationName.trim() : "";
  const users = (Array.isArray(r.allowedUsers) ? r.allowedUsers : []).flatMap((u): AlexaConfig["allowedUsers"] => {
    const x = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
    if (typeof x.id !== "string" || !AMAZON_USER.test(x.id)) return [];
    const label = typeof x.name === "string" ? x.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "";
    return [{ id: x.id, name: label || "Echo", addedAt: typeof x.addedAt === "number" && Number.isFinite(x.addedAt) ? x.addedAt : 0 }];
  });
  const num = (v: unknown, o: { min: number; max: number; def: number }, whole = true): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(o.max, Math.max(o.min, whole ? Math.round(v) : Math.round(v * 10) / 10)) : o.def);
  const locales = [...new Set((Array.isArray(r.locales) ? r.locales : []).filter((l): l is AlexaLocale => (ALEXA_LOCALES as readonly unknown[]).includes(l)))];
  const tools = [...new Set((Array.isArray(r.extraVoiceTools) ? r.extraVoiceTools : []).filter((t): t is string => typeof t === "string" && TOOL_NAME.test(t) && !isNeverByVoice(t)))].slice(0, 20);
  const maxDevices = num(r.maxDevices, ALEXA_LIMITS.maxDevices);
  return {
    installed: r.installed === true || (r.installed === undefined && (r.enabled === true || skillId !== "")),
    enabled: r.enabled === true,
    skillId,
    invocationName: name,
    skillName: (typeof r.skillName === "string" ? r.skillName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 50) : "") || "Friend Assistant",
    locales: locales.length ? locales : [...ALEXA_LOCALES],
    answerSeconds: num(r.answerSeconds, ALEXA_LIMITS.answerSeconds, false),
    holdMinutes: num(r.holdMinutes, ALEXA_LIMITS.holdMinutes),
    permissionSeconds: num(r.permissionSeconds, ALEXA_LIMITS.permissionSeconds),
    requestsPerMinute: num(r.requestsPerMinute, ALEXA_LIMITS.requestsPerMinute),
    maxDevices,
    extraVoiceTools: tools,
    allowedUsers: users.slice(0, maxDevices),
  };
}

export interface BrokersConfig {
  /** How money is written in reports, tool text and speech. */
  currencySymbol: string;
  /** The word spoken for the currency ("rupees", "dollars"). */
  currencyName: string;
  /** The number format: en-IN groups as 1,23,456.50, en-US as 123,456.50, de-DE as 123.456,50. */
  numberLocale: string;
  /** Report warnings: a holding above this share of the portfolio (percent), or down more than this today (percent). */
  concentrationPct: number;
  bigDropPct: number;
  /** How long an account read is kept, seconds (so chat and reports do not hit the broker's rate limit). */
  cacheSeconds: number;
  /** How many report schedules there may be, and how many times a report is tried in a day. */
  maxSchedules: number;
  maxTriesPerDay: number;
  /** `installed`: added from the plugins screen (or configured by an earlier version). `enabled`: switched on. The secret is write-only. */
  zerodha: { installed: boolean; enabled: boolean; apiKey: string; apiSecret: string | null };
  /** The owner's time zone, for report times. */
  timezone: string;
  /** Dates (YYYY-MM-DD) with no scheduled reports: market holidays, the owner's own days off. */
  skipDates: string[];
  /** Minutes before the first report of the day to send the broker login link (0: never). */
  loginReminderMinutes: number;
}

export interface TradingConfig {
  level: "read";
}

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** Whether the number format is a locale this PC knows. */
export const validNumberLocale = (l: unknown): l is string => {
  if (typeof l !== "string" || !l || l.length > 35) return false;
  try {
    return Intl.NumberFormat.supportedLocalesOf([l]).length === 1;
  } catch {
    return false;
  }
};

export const isValidTimeZone = (z: unknown): z is string => {
  if (typeof z !== "string" || !z) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};

const realDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export function sanitizeBrokers(raw: unknown): BrokersConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const z = (r.zerodha && typeof r.zerodha === "object" ? r.zerodha : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const reminder = typeof r.loginReminderMinutes === "number" && Number.isFinite(r.loginReminderMinutes) ? Math.min(120, Math.max(0, Math.round(r.loginReminderMinutes))) : 15;
  const num = (v: unknown, min: number, max: number, def: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def);
  return {
    currencySymbol: str(r.currencySymbol, 4) || "₹",
    currencyName: str(r.currencyName, 20) || "rupees",
    numberLocale: validNumberLocale(r.numberLocale) ? (r.numberLocale as string) : "en-IN",
    concentrationPct: num(r.concentrationPct, 5, 90, 30),
    bigDropPct: num(r.bigDropPct, 1, 50, 5),
    cacheSeconds: num(r.cacheSeconds, 5, 300, 30),
    maxSchedules: num(r.maxSchedules, 1, 50, 20),
    maxTriesPerDay: num(r.maxTriesPerDay, 1, 10, 3),
    zerodha: {
      installed: z.installed === true || (z.installed === undefined && (z.enabled === true || !!str(z.apiKey, 64))),
      enabled: z.enabled === true,
      apiKey: str(z.apiKey, 64),
      apiSecret: str(z.apiSecret, 100) || null,
    },
    timezone: isValidTimeZone(r.timezone) ? r.timezone : DEFAULT_TIMEZONE,
    skipDates: [...new Set((Array.isArray(r.skipDates) ? r.skipDates : []).filter(realDate))].sort().slice(0, 100),
    loginReminderMinutes: reminder,
  };
}

export interface ChannelsConfig {
  /** `installed`: the owner added it from the plugins screen (or an earlier version configured it). `enabled`: it is switched on. */
  telegram: { installed: boolean; enabled: boolean; botToken: string | null; /** The one chat that is the owner (set by /link). */ ownerChatId: number | null };
  twilio: { installed: boolean; enabled: boolean; accountSid: string; authToken: string | null; smsFrom: string; whatsappFrom: string; /** The owner's own phone number, in international form. */ ownerNumber: string };
}

export const DEFAULT_CHANNELS: ChannelsConfig = {
  telegram: { installed: false, enabled: false, botToken: null, ownerChatId: null },
  twilio: { installed: false, enabled: false, accountSid: "", authToken: null, smsFrom: "", whatsappFrom: "", ownerNumber: "" },
};

/** A phone number in international form, digits with an optional leading +. Anything else is dropped. */
export const phoneNumber = (v: unknown): string => (typeof v === "string" && /^\+?[0-9]{6,15}$/.test(v.replace(/[\s()-]/g, "")) ? v.replace(/[\s()-]/g, "") : "");

export function sanitizeChannels(raw: unknown): ChannelsConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as { telegram?: Record<string, unknown>; twilio?: Record<string, unknown> };
  const t = r.telegram ?? {};
  const w = r.twilio ?? {};
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  return {
    telegram: {
      // anything an earlier version already set up counts as installed
      installed: t.installed === true || (t.installed === undefined && (t.enabled === true || !!str(t.botToken))),
      enabled: t.enabled === true,
      botToken: str(t.botToken) || null,
      ownerChatId: typeof t.ownerChatId === "number" && Number.isSafeInteger(t.ownerChatId) ? t.ownerChatId : null,
    },
    twilio: {
      installed: w.installed === true || (w.installed === undefined && (w.enabled === true || !!str(w.authToken) || !!str(w.accountSid))),
      enabled: w.enabled === true,
      accountSid: str(w.accountSid, 64),
      authToken: str(w.authToken) || null,
      smsFrom: phoneNumber(w.smsFrom),
      whatsappFrom: phoneNumber(w.whatsappFrom),
      ownerNumber: phoneNumber(w.ownerNumber),
    },
  };
}

export type ApprovalMode = "manual" | "edits" | "auto";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["manual", "edits", "auto"];

export type ProviderName = "claude" | "ollama" | "claude-code" | "openai";

export interface OpenAiConfig {
  /** Ends in /v1, for example http://localhost:20128/v1 for OmniRoute. */
  url: string;
  /** The model name the server knows; OmniRoute answers to "auto". */
  model: string;
  /** Secret: never sent to the screen. Not every server asks for one. */
  apiKey: string | null;
  vision?: boolean;
}

export const DEFAULT_OPENAI: OpenAiConfig = { url: "http://localhost:20128/v1", model: "auto", apiKey: null, vision: false };

/** Using the Claude Code program (and so a Claude subscription) as the model, with no API key. */
export interface ClaudeCodeConfig {
  /** A model alias or name for `claude --model`, such as sonnet, haiku or claude-sonnet-5-5. */
  model: string;
  /** The command that starts Claude Code. */
  command: string;
  /** Where to turn when Claude Code cannot answer (not signed in, plan limit reached): the local Ollama model, or nowhere. */
  fallback: "ollama" | "none";
  /** Let Claude search the web with its own WebSearch tool, so it can answer about today (prices, news) instead of from memory. */
  webSearch: boolean;
}

export const DEFAULT_CLAUDE_CODE: ClaudeCodeConfig = { model: "sonnet", command: "claude", fallback: "ollama", webSearch: true };

/** A model or command is one word: anything with spaces could smuggle extra arguments, so such values are cut or replaced. */
export function sanitizeClaudeCode(raw: unknown): ClaudeCodeConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const word = (v: unknown, fallback: string, allowSpaces = false) => {
    if (typeof v !== "string" || !v.trim()) return fallback;
    const first = v.trim().split(/\s+/)[0]!;
    return allowSpaces ? v.trim() : /^[\w.:/\\-]+$/.test(first) ? first : fallback;
  };
  return {
    model: word(r.model, DEFAULT_CLAUDE_CODE.model),
    command: word(r.command, DEFAULT_CLAUDE_CODE.command),
    fallback: r.fallback === "none" ? "none" : "ollama",
    webSearch: r.webSearch !== false,
  };
}

/** How the owner wants the voice presence to look. Saved here so every screen shows the same. */
export interface LookConfig {
  style: PresenceStyle;
  /** #rrggbb */
  accent: string;
  /** Brightness 0..1. */
  intensity: number;
  /** Size in the middle of the screen, 0.5..1.5. */
  size: number;
  /** How strongly it follows the voice, 0..1. */
  reactivity: number;
  ambient: boolean;
  captions: boolean;
  captionSize: "small" | "medium" | "large";
  /** The AI may change the style, colour and brightness to suit a topic (stage.mood, stage.presence). */
  aiMayChange: boolean;
}

export const DEFAULT_LOOK: LookConfig = { style: "sphere", accent: "#3fd8ff", intensity: 0.6, size: 1, reactivity: 0.7, ambient: true, captions: true, captionSize: "medium", aiMayChange: true };

const num = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Anything odd in an edited config falls back to the default for that one value. */
export function sanitizeLook(raw: unknown): LookConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_LOOK;
  return {
    style: r.style === "orb" || r.style === "ring" || r.style === "sphere" ? r.style : d.style,
    accent: typeof r.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(r.accent) ? r.accent.toLowerCase() : d.accent,
    intensity: num(r.intensity, 0, 1, d.intensity),
    size: num(r.size, 0.5, 1.5, d.size),
    reactivity: num(r.reactivity, 0, 1, d.reactivity),
    ambient: typeof r.ambient === "boolean" ? r.ambient : d.ambient,
    captions: typeof r.captions === "boolean" ? r.captions : d.captions,
    captionSize: r.captionSize === "small" || r.captionSize === "large" || r.captionSize === "medium" ? r.captionSize : d.captionSize,
    aiMayChange: typeof r.aiMayChange === "boolean" ? r.aiMayChange : d.aiMayChange,
  };
}

export interface OllamaConfig {
  url: string;
  model: string;
  contextTokens: number;
  /** The model can look at pictures, so the camera tool may be used with it. */
  vision?: boolean;
}

export const DEFAULT_OLLAMA: OllamaConfig = { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", contextTokens: 8192, vision: false };

export interface VoiceConfig {
  enabled: boolean;
  /** faster-whisper model name (tiny, base, small, ...). */
  sttModel: string;
  /** Piper voice name. */
  ttsVoice: string;
  /** Force a spoken language (e.g. "hi"); null detects it automatically. */
  language: string | null;
  /** Also speak the replies to messages that were typed (not only to what was said aloud). */
  speakTyped: boolean;
  /** Speaker match at or above this is the owner (0..1). */
  accept: number;
  /** Speaker match at or above this but below `accept` asks for the PIN; below it the voice is a guest. */
  challenge: number;
  /** The voice for Hindi text (Devanagari). Empty: the main voice reads it. */
  hindiVoice: string;
  /** The voice for Marathi text (Devanagari). Empty: the main voice reads it. */
  marathiVoice: string;
  /** Turn music and video down while the owner talks to Friend and while Friend speaks. */
  duck: boolean;
  /** How loud they are then, as a percent of how loud they were (0 to 100). */
  duckPercent: number;
}

export interface UpdatesConfig {
  /** Look for a newer Friend when it starts, and install it by itself while Friend is not busy. */
  auto: boolean;
}

/** Searching the web: `web.search` and `web.read`, for every model. */
export type WebProvider = "duckduckgo" | "brave" | "tavily" | "searxng";
export interface WebConfig {
  enabled: boolean;
  /** Where searches are sent. DuckDuckGo needs no key; the others need the owner's key or address. */
  provider: WebProvider;
  /** The owner's own SearXNG server (http or https), when that is the source. */
  searxngUrl: string;
  braveKey: string | null;
  tavilyKey: string | null;
}
export const WEB_PROVIDERS: readonly WebProvider[] = ["duckduckgo", "brave", "tavily", "searxng"];
export const DEFAULT_WEB: WebConfig = { enabled: true, provider: "duckduckgo", searxngUrl: "", braveKey: null, tavilyKey: null };

/** A web address with no login in it, or nothing. */
export function plainWebAddress(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 300) return "";
  try {
    const u = new URL(v.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? v.trim() : "";
  } catch {
    return "";
  }
}
const key = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.trim().length <= 200 ? v.trim() : null);
export function sanitizeWeb(raw: unknown): WebConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : true,
    provider: WEB_PROVIDERS.includes(r.provider as WebProvider) ? (r.provider as WebProvider) : "duckduckgo",
    searxngUrl: plainWebAddress(r.searxngUrl),
    braveKey: key(r.braveKey),
    tavilyKey: key(r.tavilyKey),
  };
}
/** How Friend keeps the model's own conversation from growing without end. */
export interface SessionConfig {
  /** Write notes and start a fresh conversation by itself when it passes `compactAtTokens`. */
  autoCompact: boolean;
  compactAtTokens: number;
}

export const MIN_COMPACT_TOKENS = 50_000; // a fresh conversation already starts near 36K
export const MAX_COMPACT_TOKENS = 800_000;
export const sanitizeSession = (s: Partial<SessionConfig> | undefined): SessionConfig => ({
  autoCompact: typeof s?.autoCompact === "boolean" ? s.autoCompact : true,
  compactAtTokens: typeof s?.compactAtTokens === "number" && Number.isFinite(s.compactAtTokens) ? Math.min(MAX_COMPACT_TOKENS, Math.max(MIN_COMPACT_TOKENS, Math.round(s.compactAtTokens))) : 100_000,
});

export const sanitizeUpdates = (u: Partial<UpdatesConfig> | undefined): UpdatesConfig => ({ auto: typeof u?.auto === "boolean" ? u.auto : true });

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: true,
  sttModel: "small",
  ttsVoice: "en_US-lessac-medium",
  language: null,
  speakTyped: true,
  accept: 0.72,
  challenge: 0.58,
  hindiVoice: DEFAULT_HINDI_VOICE,
  marathiVoice: DEFAULT_MARATHI_VOICE,
  duck: true,
  duckPercent: 25,
};

/** Bad thresholds in an edited config must never make strangers look like the owner, so they fall back to the defaults. */
export function sanitizeVoice(v: VoiceConfig): VoiceConfig {
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const percent = typeof v.duckPercent === "number" && Number.isFinite(v.duckPercent) ? Math.max(0, Math.min(100, Math.round(v.duckPercent))) : DEFAULT_VOICE.duckPercent;
  const base = { ...v, duck: typeof v.duck === "boolean" ? v.duck : DEFAULT_VOICE.duck, duckPercent: percent };
  if (ok(v.accept) && ok(v.challenge) && v.accept > v.challenge) return base;
  return { ...base, accept: DEFAULT_VOICE.accept, challenge: DEFAULT_VOICE.challenge };
}

export const DEFAULT_DESTRUCTIVE_PATTERNS = [
  String.raw`\brm\s+(-[a-z]*r|-[a-z]*f)`,
  String.raw`\bremove-item\b.*-recurse`,
  String.raw`\brmdir\b.*\/s`,
  String.raw`\bdel\b.*\/[sfq]`,
  String.raw`\bformat\b\s+[a-z]:`,
  String.raw`\bdiskpart\b`,
  String.raw`\bshutdown\b`,
  String.raw`\brestart-computer\b`,
  String.raw`\bstop-computer\b`,
  String.raw`\breg\s+(add|delete|import)`,
  String.raw`\bnet\s+user\b`,
  String.raw`\bicacls\b`,
  String.raw`\bchmod\b|\bchown\b`,
  String.raw`\bmkfs\b`,
  String.raw`\bdd\s+if=`,
  String.raw`c:[\\/]+windows`,
  String.raw`\$env:(windir|systemroot)|%(windir|systemroot)%`,
  String.raw`\b(ri|rm|del|erase|rd|rmdir|remove-item)\b.*\s-r(e(c(u(r(se?)?)?)?)?)?\b`,
  String.raw`\b(rd|rmdir)\b.*\/s`,
  String.raw`\b(format-volume|clear-disk|initialize-disk|remove-partition)\b`,
  String.raw`\[io\.(directory|file)\]::delete`,
  String.raw`\s-(enc\w*|ec)\b`,
  String.raw`\b(iex|invoke-expression)\b`,
];

export function defaultDataDir(): string {
  return process.env.FRIEND_HOME ?? join(homedir(), ".friend");
}

const defaults = (dataDir: string): Config => ({
  bind: "127.0.0.1",
  port: 8787,
  publicUrl: null,
  https: false,
  trustProxy: false,
  allowedOrigins: [],
  allowedHosts: [],
  roots: [],
  destructivePatterns: DEFAULT_DESTRUCTIVE_PATTERNS,
  model: "claude-sonnet-5-5",
  apiKey: null,
  provider: "claude",
  ollama: { ...DEFAULT_OLLAMA },
  openai: { ...DEFAULT_OPENAI },
  claudeCode: { ...DEFAULT_CLAUDE_CODE },
  voice: { ...DEFAULT_VOICE },
  updates: sanitizeUpdates(undefined),
  session: sanitizeSession(undefined),
  web: sanitizeWeb(undefined),
  view: "companion",
  look: { ...DEFAULT_LOOK },
  ownerName: "",
  approvals: "manual",
  channels: sanitizeChannels(DEFAULT_CHANNELS),
  brokers: sanitizeBrokers({}),
  trading: { level: "read" },
  alexa: sanitizeAlexa({}),
  music: sanitizeMusic({}),
  chrome: sanitizeChrome({}),
  video: sanitizeVideo({}),
  hud: sanitizeHud({}),
  office: sanitizeOffice({}),
  dataDir,
});

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

export function saveConfig(cfg: Partial<Config> & { dataDir: string }): void {
  const { dataDir, ...rest } = cfg;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath(dataDir), JSON.stringify(rest, null, 2));
  try {
    chmodSync(configPath(dataDir), 0o600);
  } catch {
    /* permission bits unsupported on this OS */
  }
}

export function loadConfig(dataDir: string = defaultDataDir()): Config {
  mkdirSync(dataDir, { recursive: true });
  const file = configPath(dataDir);
  const base = defaults(dataDir);
  if (!existsSync(file)) {
    const { dataDir: _d, ...rest } = base;
    saveConfig({ ...rest, dataDir });
    return base;
  }
  const stored = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
  // Built-in destructive patterns can only be extended, never dropped by an old or edited config file.
  const destructivePatterns = [...new Set([...base.destructivePatterns, ...(stored.destructivePatterns ?? [])])];
  return {
    ...base,
    ...stored,
    https: stored.https === true,
    destructivePatterns,
    ollama: { ...DEFAULT_OLLAMA, ...stored.ollama },
    openai: { ...DEFAULT_OPENAI, ...stored.openai },
    claudeCode: sanitizeClaudeCode(stored.claudeCode),
    voice: sanitizeVoice({ ...DEFAULT_VOICE, ...stored.voice }),
    updates: sanitizeUpdates(stored.updates),
  session: sanitizeSession(stored.session),
  web: sanitizeWeb(stored.web),
    view: stored.view === "minimal" || stored.view === "workspace" ? stored.view : "companion",
    look: sanitizeLook(stored.look),
    ownerName: typeof stored.ownerName === "string" ? stored.ownerName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "",
    approvals: stored.approvals === "edits" || stored.approvals === "auto" ? stored.approvals : "manual",
    channels: sanitizeChannels(stored.channels),
    brokers: sanitizeBrokers(stored.brokers),
    trading: { level: "read" }, // any other level in the file is read as read: orders do not exist in this version
    alexa: sanitizeAlexa(stored.alexa),
    music: sanitizeMusic(stored.music),
    chrome: sanitizeChrome(stored.chrome),
    video: sanitizeVideo(stored.video),
    hud: sanitizeHud(stored.hud),
    office: sanitizeOffice(stored.office),
    dataDir,
  };
}
