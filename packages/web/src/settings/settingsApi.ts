export type ApprovalMode = "manual" | "edits" | "auto";

/** Telegram, SMS and WhatsApp as the screen sees them: the tokens themselves are never sent here. */
export interface ChannelsView {
  telegram: { enabled: boolean; tokenSet: boolean; linked: boolean };
  twilio: { enabled: boolean; accountSid: string; tokenSet: boolean; smsFrom: string; whatsappFrom: string; ownerNumber: string };
}
export type ProviderName = "claude" | "claude-code" | "ollama" | "openai";

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
  look: Look;
  ollama: { url: string; model: string; vision: boolean; contextTokens: number };
  /** Any OpenAI-compatible server, such as OmniRoute. The key itself is never sent to the screen. */
  openai?: { url: string; model: string; vision: boolean; apiKeySet: boolean };
  claudeCode: { model: string; command: string; fallback: "ollama" | "none" };
  voice: { enabled: boolean; speakTyped: boolean; language: string | null; accept: number; challenge: number; ttsVoice: string; sttModel: string; hindiVoice?: string; marathiVoice?: string };
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
export function diffSettings(before: SettingsView, after: SettingsView, apiKey: string, openaiKey = "", channelSecrets = { telegramToken: "", twilioToken: "" }): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.provider !== before.provider) patch.provider = after.provider;
  if (after.model !== before.model) patch.model = after.model;
  if (after.view !== before.view) patch.view = after.view;
  if ((after.ownerName ?? "") !== (before.ownerName ?? "")) patch.ownerName = after.ownerName ?? "";
  if ((after.approvals ?? "manual") !== (before.approvals ?? "manual")) patch.approvals = after.approvals ?? "manual";
  if (before.channels && after.channels) {
    const telegram: Record<string, unknown> = {};
    if (after.channels.telegram.enabled !== before.channels.telegram.enabled) telegram.enabled = after.channels.telegram.enabled;
    if (channelSecrets.telegramToken.trim()) telegram.botToken = channelSecrets.telegramToken.trim();
    const twilio: Record<string, unknown> = {};
    for (const k of ["enabled", "accountSid", "smsFrom", "whatsappFrom", "ownerNumber"] as const) if (after.channels.twilio[k] !== before.channels.twilio[k]) twilio[k] = after.channels.twilio[k];
    if (channelSecrets.twilioToken.trim()) twilio.authToken = channelSecrets.twilioToken.trim();
    const channels: Record<string, unknown> = {};
    if (Object.keys(telegram).length) channels.telegram = telegram;
    if (Object.keys(twilio).length) channels.twilio = twilio;
    if (Object.keys(channels).length) patch.channels = channels;
  }
  if (apiKey.trim()) patch.apiKey = apiKey.trim();
  for (const group of ["ollama", "claudeCode", "voice", "look"] as const) {
    const changed: Record<string, unknown> = {};
    for (const k of Object.keys(after[group]) as string[]) {
      const a = (after[group] as Record<string, unknown>)[k];
      if (a !== (before[group] as Record<string, unknown>)[k]) changed[k] = group === "voice" && k === "language" ? (a ?? "") : a;
    }
    if (Object.keys(changed).length) patch[group] = changed;
  }
  if (before.openai && after.openai) {
    const changed: Record<string, unknown> = {};
    for (const k of ["url", "model", "vision"] as const) if (after.openai[k] !== before.openai[k]) changed[k] = after.openai[k];
    if (openaiKey.trim()) changed.apiKey = openaiKey.trim();
    if (Object.keys(changed).length) patch.openai = changed;
  }
  return patch;
}
