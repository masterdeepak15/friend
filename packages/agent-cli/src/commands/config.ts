import { loadConfig, saveConfig, type Config } from "@friend/server";
import type { IO } from "../cli";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v: string) => {
  if (v !== "true" && v !== "false") throw new Error("Expected true or false");
  return v === "true";
};
const nonEmpty = (v: string) => {
  if (!v.trim()) throw new Error("Value must not be empty");
  return v.trim();
};
const unit = (v: string) => {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n) || n < 0 || n > 1) throw new Error("Expected a number between 0 and 1");
  return n;
};
const httpUrl = (v: string) => {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error("Expected a URL such as http://127.0.0.1:11434");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The URL must start with http:// or https://");
  return u.origin;
};

const PARSERS: Record<string, (v: string) => unknown> = {
  apiKey: (v) => v,
  model: (v) => v,
  bind: (v) => v,
  publicUrl: (v) => (v === "" ? null : v),
  port: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("Port must be a number between 0 and 65535");
    return n;
  },
  provider: (v) => {
    if (v !== "claude" && v !== "ollama" && v !== "claude-code") throw new Error("Provider must be claude, ollama or claude-code");
    return v;
  },
  roots: list,
  allowedOrigins: list,
  allowedHosts: list,
  trustProxy: bool,
};

const GROUPS: Record<string, Record<string, (v: string) => unknown>> = {
  voice: {
    enabled: bool,
    sttModel: nonEmpty,
    ttsVoice: nonEmpty,
    language: (v) => (v.trim() === "" ? null : v.trim()),
    speakTyped: bool,
    accept: unit,
    challenge: unit,
  },
  claudeCode: {
    model: (v) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v.trim())) throw new Error("Expected a model name such as sonnet, haiku or claude-sonnet-5-5");
      return v.trim();
    },
    command: nonEmpty,
    fallback: (v) => {
      if (v !== "ollama" && v !== "none") throw new Error("Fallback must be ollama or none");
      return v;
    },
  },
  ollama: {
    url: httpUrl,
    model: nonEmpty,
    vision: bool,
    contextTokens: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1024 || n > 131072) throw new Error("contextTokens must be a whole number between 1024 and 131072");
      return n;
    },
  },
};

const allKeys = () => [...Object.keys(PARSERS), ...Object.entries(GROUPS).flatMap(([g, f]) => Object.keys(f).map((k) => `${g}.${k}`))];

export async function configCommand(args: string[], io: IO): Promise<number> {
  const [sub, key, ...valueParts] = args;
  if (sub !== "set" || !key) {
    io.err("Usage: friend config set <key> <value>");
    return 1;
  }
  const value = valueParts.join(" ");
  const cfg = loadConfig(io.dataDir);

  const dot = key.indexOf(".");
  if (dot > 0) {
    const group = key.slice(0, dot);
    const field = key.slice(dot + 1);
    const parse = GROUPS[group]?.[field];
    if (!parse) {
      io.err(`Unknown setting "${key}". Settings: ${allKeys().join(", ")}`);
      return 1;
    }
    (cfg[group as "voice" | "ollama" | "claudeCode"] as unknown as Record<string, unknown>)[field] = parse(value);
  } else {
    const parse = PARSERS[key];
    if (!parse) {
      io.err(`Unknown config key "${key}". Keys: ${allKeys().join(", ")}`);
      return 1;
    }
    (cfg as unknown as Record<string, unknown>)[key] = parse(value);
  }
  saveConfig(cfg as Config);
  io.out(`Saved ${key}.`);
  return 0;
}
