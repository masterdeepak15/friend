import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  bind: string;
  port: number;
  publicUrl: string | null;
  trustProxy: boolean;
  allowedOrigins: string[];
  roots: string[];
  destructivePatterns: string[];
  model: string;
  apiKey: string | null;
  dataDir: string;
}

export const DEFAULT_DESTRUCTIVE_PATTERNS = [
  "\brm\s+(-[a-z]*r|-[a-z]*f)",
  "\bremove-item\b.*-recurse",
  "\brmdir\b.*\/s",
  "\bdel\b.*\/[sfq]",
  "\bformat\b\s+[a-z]:",
  "\bdiskpart\b",
  "\bshutdown\b",
  "\brestart-computer\b",
  "\bstop-computer\b",
  "\breg\s+(add|delete|import)",
  "\bnet\s+user\b",
  "\bicacls\b",
  "\bchmod\b|\bchown\b",
  "\bmkfs\b",
  "\bdd\s+if=",
  "c:\\windows",
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
  roots: [],
  destructivePatterns: DEFAULT_DESTRUCTIVE_PATTERNS,
  model: "claude-sonnet-5-5",
  apiKey: null,
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
  return { ...base, ...stored, dataDir };
}
