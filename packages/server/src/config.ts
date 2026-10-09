import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_HINDI_VOICE, DEFAULT_MARATHI_VOICE, type PresenceStyle, type ViewPreset } from "@friend/protocol";
import { homedir } from "node:os";
import { join } from "node:path";

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
  /** What the screen shows besides the AI's pictures: minimal, companion (status line and clock) or workspace (also chat and schedule). */
  view: ViewPreset;
  look: LookConfig;
  /** What the profile badge on the screen calls the owner. Empty shows "Owner". */
  ownerName: string;
  dataDir: string;
}

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
}

export const DEFAULT_CLAUDE_CODE: ClaudeCodeConfig = { model: "sonnet", command: "claude", fallback: "ollama" };

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
}

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: true,
  sttModel: "base",
  ttsVoice: "en_US-lessac-medium",
  language: null,
  speakTyped: true,
  accept: 0.72,
  challenge: 0.58,
  hindiVoice: DEFAULT_HINDI_VOICE,
  marathiVoice: DEFAULT_MARATHI_VOICE,
};

/** Bad thresholds in an edited config must never make strangers look like the owner, so they fall back to the defaults. */
export function sanitizeVoice(v: VoiceConfig): VoiceConfig {
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (ok(v.accept) && ok(v.challenge) && v.accept > v.challenge) return v;
  return { ...v, accept: DEFAULT_VOICE.accept, challenge: DEFAULT_VOICE.challenge };
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
  view: "companion",
  look: { ...DEFAULT_LOOK },
  ownerName: "",
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
    view: stored.view === "minimal" || stored.view === "workspace" ? stored.view : "companion",
    look: sanitizeLook(stored.look),
    ownerName: typeof stored.ownerName === "string" ? stored.ownerName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) : "",
    dataDir,
  };
}
