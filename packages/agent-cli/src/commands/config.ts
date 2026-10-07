import { loadConfig, saveConfig, type Config } from "@friend/server";
import type { IO } from "../cli";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v: string) => {
  if (v !== "true" && v !== "false") throw new Error("Expected true or false");
  return v === "true";
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
  trustProxy: bool,
};

export async function configCommand(args: string[], io: IO): Promise<number> {
  const [sub, key, ...valueParts] = args;
  if (sub !== "set" || !key) {
    io.err("Usage: friend config set <key> <value>");
    return 1;
  }
  const parse = PARSERS[key];
  if (!parse) {
    io.err(`Unknown config key "${key}". Keys: ${Object.keys(PARSERS).join(", ")}`);
    return 1;
  }
  const cfg = loadConfig(io.dataDir);
  (cfg as unknown as Record<string, unknown>)[key] = parse(valueParts.join(" "));
  saveConfig(cfg as Config);
  io.out(`Saved ${key}.`);
  return 0;
}
