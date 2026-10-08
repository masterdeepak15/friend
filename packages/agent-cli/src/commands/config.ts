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
  roots: list,
  allowedOrigins: list,
  allowedHosts: list,
  trustProxy: bool,
};

const VOICE_PARSERS: Record<string, (v: string) => unknown> = {
  enabled: bool,
  sttModel: nonEmpty,
  ttsVoice: nonEmpty,
  language: (v) => (v.trim() === "" ? null : v.trim()),
};

export async function configCommand(args: string[], io: IO): Promise<number> {
  const [sub, key, ...valueParts] = args;
  if (sub !== "set" || !key) {
    io.err("Usage: friend config set <key> <value>");
    return 1;
  }
  const value = valueParts.join(" ");
  const cfg = loadConfig(io.dataDir);

  if (key.startsWith("voice.")) {
    const field = key.slice("voice.".length);
    const parse = VOICE_PARSERS[field];
    if (!parse) {
      io.err(`Unknown voice setting "${field}". Settings: ${Object.keys(VOICE_PARSERS).map((k) => `voice.${k}`).join(", ")}`);
      return 1;
    }
    (cfg.voice as unknown as Record<string, unknown>)[field] = parse(value);
  } else {
    const parse = PARSERS[key];
    if (!parse) {
      io.err(`Unknown config key "${key}". Keys: ${[...Object.keys(PARSERS), ...Object.keys(VOICE_PARSERS).map((k) => `voice.${k}`)].join(", ")}`);
      return 1;
    }
    (cfg as unknown as Record<string, unknown>)[key] = parse(value);
  }
  saveConfig(cfg as Config);
  io.out(`Saved ${key}.`);
  return 0;
}
