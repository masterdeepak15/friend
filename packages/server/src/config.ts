import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  bind: string;
  port: number;
  publicUrl: string | null;
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
  voice: VoiceConfig;
  dataDir: string;
}

export type ProviderName = "claude" | "ollama";

export interface OllamaConfig {
  url: string;
  model: string;
  contextTokens: number;
}

export const DEFAULT_OLLAMA: OllamaConfig = { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", contextTokens: 8192 };

export interface VoiceConfig {
  enabled: boolean;
  /** faster-whisper model name (tiny, base, small, ...). */
  sttModel: string;
  /** Piper voice name. */
  ttsVoice: string;
  /** Force a spoken language (e.g. "hi"); null detects it automatically. */
  language: string | null;
  /** Speaker match at or above this is the owner (0..1). */
  accept: number;
  /** Speaker match at or above this but below `accept` asks for the PIN; below it the voice is a guest. */
  challenge: number;
}

export const DEFAULT_VOICE: VoiceConfig = {
  enabled: true,
  sttModel: "base",
  ttsVoice: "en_US-lessac-medium",
  language: null,
  accept: 0.72,
  challenge: 0.58,
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
  trustProxy: false,
  allowedOrigins: [],
  allowedHosts: [],
  roots: [],
  destructivePatterns: DEFAULT_DESTRUCTIVE_PATTERNS,
  model: "claude-sonnet-5-5",
  apiKey: null,
  provider: "claude",
  ollama: { ...DEFAULT_OLLAMA },
  voice: { ...DEFAULT_VOICE },
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
    destructivePatterns,
    ollama: { ...DEFAULT_OLLAMA, ...stored.ollama },
    voice: sanitizeVoice({ ...DEFAULT_VOICE, ...stored.voice }),
    dataDir,
  };
}
