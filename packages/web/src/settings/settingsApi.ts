import { HUD_WIDGET_IDS, type OfficeProject, type OfficeRole } from "@friend/protocol";

export type ApprovalMode = "manual" | "edits" | "auto";

/** Telegram, SMS and WhatsApp as the screen sees them: the tokens themselves are never sent here. */
export interface ChannelsView {
  telegram: { installed: boolean; enabled: boolean; tokenSet: boolean; linked: boolean };
  twilio: { installed: boolean; enabled: boolean; accountSid: string; tokenSet: boolean; smsFrom: string; whatsappFrom: string; ownerNumber: string };
}
/** The stock-broker settings as the screen sees them: the secret itself is never sent, only whether one is saved. */
export interface BrokersView {
  zerodha: { installed: boolean; enabled: boolean; apiKey: string; secretSet: boolean };
  timezone: string;
  skipDates: string[];
  loginReminderMinutes: number;
  /** How money is written and spoken, the warning levels in reports, and the limits. */
  currencySymbol: string;
  currencyName: string;
  numberLocale: string;
  concentrationPct: number;
  bigDropPct: number;
  cacheSeconds: number;
  maxSchedules: number;
  maxTriesPerDay: number;
}
/** The Alexa settings as the screen sees them: allowed Echo ids are shortened. */
export interface AlexaView {
  installed: boolean;
  enabled: boolean;
  skillId: string;
  invocationName: string;
  allowed: { id: string; name: string }[];
  skillName: string;
  locales: string[];
  answerSeconds: number;
  holdMinutes: number;
  permissionSeconds: number;
  requestsPerMinute: number;
  maxDevices: number;
  extraVoiceTools: string[];
}
/** The music player's settings (the folder is shown here because only the owner sees this screen). */
export interface MusicSettings {
  folder: string;
  extensions: string[];
  maxTracks: number;
  scanDepth: number;
  volume: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  visualizer: boolean;
  startView: "mini" | "full";
  defaultSource: "local" | "spotify" | "soundcloud" | "audius" | "any";
  searchLimit: number;
  output: "screen" | "host";
  hostPlayer: string;
  spotifyDevice: string;
  /** The Spotify plugin entry; changed only through the plugin, never from the settings screen. */
  spotify: { installed: boolean; enabled: boolean; clientId: string };
  soundcloud: { installed: boolean; enabled: boolean; clientId: string };
  audius: { installed: boolean; enabled: boolean };
}
/** The screen widgets: profile tag, date and time, quick-launch buttons, animations. */
export interface HudSettings {
  terminalLabel: string;
  clock: { hour12: boolean; seconds: boolean; locale: string };
  launcher: { id?: string; label: string; icon: string; action: { type: "url" | "prompt" | "panel" | "music"; value: string } }[];
  animations: "full" | "reduced" | "off";
  layout: "classic" | "orbital";
  density: "calm" | "standard" | "full";
  /** Instruments switched on or off by hand (a missing one follows the density). */
  widgets: Partial<Record<(typeof HUD_WIDGET_IDS)[number], boolean>>;
  /** Fill the orbital screen with sample content (clearly labelled) to preview the look before workers exist. */
  preview?: boolean;
}

/** The Office as the settings screen edits it (the same shape the server keeps). */
export interface OfficeSettings {
  enabled: boolean;
  maxConcurrent: number;
  startTimeoutSec: number;
  pauseAtWindow: number;
  notifyFriend: boolean;
  autonomy: "low" | "medium" | "high";
  budget: { perWorkerTokens: number; totalTokens: number };
  roles: OfficeRole[];
  projects: OfficeProject[];
  policy: { allowTools: string[]; denyCommands: string[] };
}

export type ProviderName ="claude" | "claude-code" | "ollama" | "openai";

/** What Friend remembers: the tree of notes, saving by itself, and how much of the index it sees every turn. */
export interface MemorySettings {
  enabled: boolean;
  autoSave: "off" | "on";
  showSaved: boolean;
  autoTidy: boolean;
  saveDelaySec: number;
  maxIndexChars: number;
}

export interface SettingsView {
  provider: ProviderName;
  model: string;
  /** The key itself is never sent to the screen. */
  apiKeySet: boolean;
  view: "minimal" | "companion" | "workspace";
  /** What the profile badge calls the owner. */
  ownerName?: string;
  /** How much Friend asks before acting. */
  approvals?: ApprovalMode;
  channels?: ChannelsView;
  brokers?: BrokersView;
  /** What Friend may do with money. Only "read" exists in this version. */
  trading?: { level: "read" };
  alexa?: AlexaView;
  music?: MusicSettings;
  hud?: HudSettings;
  office?: OfficeSettings;
  memory?: MemorySettings;
  look: Look;
  ollama: { url: string; model: string; vision: boolean; contextTokens: number };
  /** Any OpenAI-compatible server, such as OmniRoute. The key itself is never sent to the screen. */
  openai?: { url: string; model: string; vision: boolean; apiKeySet: boolean };
  claudeCode: { model: string; command: string; fallback: "ollama" | "none"; webSearch?: boolean };
  updates?: { auto: boolean };
  session?: { autoCompact: boolean; compactAtTokens: number };
  /** Searching the web. The keys are never sent here, only whether they are set. */
  web?: { enabled: boolean; provider: "duckduckgo" | "brave" | "tavily" | "searxng"; searxngUrl: string; braveKeySet: boolean; tavilyKeySet: boolean };
  voice: { enabled: boolean; speakTyped: boolean; language: string | null; accept: number; challenge: number; ttsVoice: string; sttModel: string; hindiVoice?: string; marathiVoice?: string; duck?: boolean; duckPercent?: number };
}

export type PresenceStyleName = "sphere" | "orb" | "ring";

/** How the owner wants the voice presence and captions to look. */
export interface Look {
  style: PresenceStyleName;
  /** #rrggbb */
  accent: string;
  intensity: number;
  size: number;
  reactivity: number;
  ambient: boolean;
  captions: boolean;
  captionSize: "small" | "medium" | "large";
  aiMayChange: boolean;
}

export const DEFAULT_LOOK: Look = { style: "sphere", accent: "#3fd8ff", intensity: 0.6, size: 1, reactivity: 0.7, ambient: true, captions: true, captionSize: "medium", aiMayChange: true };

/** Changes that only affect how the screen looks, which need no PIN. */
export const COSMETIC = new Set(["view", "look", "ownerName"]);
export const needsPin = (patch: Record<string, unknown>): boolean => Object.keys(patch).some((k) => !COSMETIC.has(k));

export interface SaveResult {
  settings: SettingsView;
  changed: boolean;
  /** Settings that only take effect after Friend restarts. */
  restart: string[];
}

export interface SettingsApi {
  get(): Promise<SettingsView>;
  /** The PIN is needed for everything except the view. */
  save(settings: Record<string, unknown>, pin?: string): Promise<SaveResult>;
}

async function call<T>(init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/settings", init);
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* no JSON body */
    }
    throw new Error(detail || (res.status === 401 ? "Please sign in again." : res.status === 429 ? "Too many attempts. Wait a moment." : `The request failed (${res.status}).`));
  }
  return (await res.json()) as T;
}

export const httpSettingsApi: SettingsApi = {
  get: () => call<SettingsView>(),
  save: (settings, pin) => call<SaveResult>({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) }),
};

/**
 * Plays a short sentence in the named voice, so it can be heard before it is chosen. Resolves when playback has started and
 * rejects with a sentence the owner can read (no speech engine, no internet the first time, and so on).
 */
export async function playVoicePreview(voice: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/voice/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ voice }) });
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      /* no JSON body */
    }
    throw new Error(detail || `The request failed (${res.status}).`);
  }
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  try {
    await audio.play();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("The browser blocked the sound. Click anywhere on the page, then try again.");
  }
}

/** Only what the owner actually changed, in the shape the server accepts. `apiKey` is sent only when something was typed. */
export function diffSettings(before: SettingsView, after: SettingsView, apiKey: string, openaiKey = "", webKeys: { brave: string; tavily: string } = { brave: "", tavily: "" }): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.provider !== before.provider) patch.provider = after.provider;
  if (after.model !== before.model) patch.model = after.model;
  if (after.view !== before.view) patch.view = after.view;
  if ((after.ownerName ?? "") !== (before.ownerName ?? "")) patch.ownerName = after.ownerName ?? "";
  if ((after.approvals ?? "manual") !== (before.approvals ?? "manual")) patch.approvals = after.approvals ?? "manual";
  if (apiKey.trim()) patch.apiKey = apiKey.trim();
  for (const group of ["ollama", "claudeCode", "voice", "look", "updates", "session", "memory"] as const) {
    if (!after[group] || !before[group]) continue;
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after[group]) as string[]) {
      const a = (after[group] as Record<string, unknown>)[k];
      if (a !== (before[group] as Record<string, unknown>)[k]) changed[k] = group === "voice" && k === "language" ? (a ?? "") : a;
    }
    if (Object.keys(changed).length) patch[group] = changed;
  }
  if (before.music && after.music) {
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after.music) as (keyof MusicSettings)[]) if (JSON.stringify(after.music[k]) !== JSON.stringify(before.music[k])) changed[k] = after.music[k];
    if (Object.keys(changed).length) patch.music = changed;
  }
  if (before.hud && after.hud) {
    const changed: Record<string, unknown> = {};
    if (after.hud.terminalLabel !== before.hud.terminalLabel) changed.terminalLabel = after.hud.terminalLabel;
    if (after.hud.animations !== before.hud.animations) changed.animations = after.hud.animations;
    if (after.hud.layout !== before.hud.layout) changed.layout = after.hud.layout;
    if (after.hud.density !== before.hud.density) changed.density = after.hud.density;
    if ((after.hud.preview === true) !== (before.hud.preview === true)) changed.preview = after.hud.preview === true;
    const widgets: Record<string, boolean> = {};
    for (const id of HUD_WIDGET_IDS) if (after.hud.widgets[id] !== before.hud.widgets[id] && typeof after.hud.widgets[id] === "boolean") widgets[id] = after.hud.widgets[id] as boolean;
    if (Object.keys(widgets).length) changed.widgets = widgets;
    const clock: Record<string, unknown> = {};
    for (const k of Object.keys(after.hud.clock) as (keyof HudSettings["clock"])[]) if (after.hud.clock[k] !== before.hud.clock[k]) clock[k] = after.hud.clock[k];
    if (Object.keys(clock).length) changed.clock = clock;
    if (JSON.stringify(after.hud.launcher) !== JSON.stringify(before.hud.launcher)) changed.launcher = after.hud.launcher;
    if (Object.keys(changed).length) patch.hud = changed;
  }
  if (before.office && after.office) {
    const changed: Record<string, unknown> = {};
    const a = after.office;
    const b = before.office;
    for (const k of ["enabled", "maxConcurrent", "startTimeoutSec", "pauseAtWindow", "notifyFriend", "autonomy"] as const) if (a[k] !== b[k]) changed[k] = a[k];
    const budget: Record<string, number> = {};
    for (const k of ["perWorkerTokens", "totalTokens"] as const) if (a.budget[k] !== b.budget[k]) budget[k] = a.budget[k];
    if (Object.keys(budget).length) changed.budget = budget;
    if (JSON.stringify(a.roles) !== JSON.stringify(b.roles)) changed.roles = a.roles;
    if (JSON.stringify(a.projects) !== JSON.stringify(b.projects)) changed.projects = a.projects;
    const policy: Record<string, string[]> = {};
    for (const k of ["allowTools", "denyCommands"] as const) if (JSON.stringify(a.policy[k]) !== JSON.stringify(b.policy[k])) policy[k] = a.policy[k];
    if (Object.keys(policy).length) changed.policy = policy;
    if (Object.keys(changed).length) patch.office = changed;
  }
  if (before.web && after.web) {
    const changed: Record<string, unknown> = {};
    for (const k of ["enabled", "provider", "searxngUrl"] as const) if (after.web[k] !== before.web[k]) changed[k] = after.web[k];
    if (webKeys.brave.trim()) changed.braveKey = webKeys.brave.trim();
    if (webKeys.tavily.trim()) changed.tavilyKey = webKeys.tavily.trim();
    if (Object.keys(changed).length) patch.web = changed;
  }
  if (before.openai && after.openai) {
    const changed: Record<string, unknown> = {};
    for (const k of ["url", "model", "vision"] as const) if (after.openai[k] !== before.openai[k]) changed[k] = after.openai[k];
    if (openaiKey.trim()) changed.apiKey = openaiKey.trim();
    if (Object.keys(changed).length) patch.openai = changed;
  }
  return patch;
}
