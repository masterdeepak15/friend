import { loadConfig, saveConfig, type Config } from "@friend/server";
import { isIP } from "node:net";
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
  bind: (v) => {
    const t = v.trim();
    if (t !== "localhost" && isIP(t) === 0) throw new Error("bind must be an IP address such as 127.0.0.1 (this PC only) or 0.0.0.0 (also your network), or localhost. Easier: friend lan on");
    return t;
  },
  publicUrl: (v) => (v === "" ? null : v),
  ownerName: (v) => {
    const name = v.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    if (name.length > 40) throw new Error("The name can be at most 40 characters");
    return name;
  },
  https: bool,
  port: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("Port must be a number between 0 and 65535");
    return n;
  },
  provider: (v) => {
    if (v !== "claude" && v !== "ollama" && v !== "claude-code" && v !== "openai") throw new Error("Provider must be claude, ollama, claude-code or openai");
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
    hindiVoice: (v) => {
      if (!/^[A-Za-z0-9_-]*$/.test(v.trim())) throw new Error("A Piper voice name such as hi_IN-priyamvada-medium, or empty to use the main voice");
      return v.trim();
    },
    marathiVoice: (v) => {
      if (!/^[A-Za-z0-9_-]*$/.test(v.trim())) throw new Error("A Piper voice name such as mr_IN-google-medium, or empty to use the main voice");
      return v.trim();
    },
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
  openai: {
    url: (v) => {
      let u: URL;
      try {
        u = new URL(v.trim());
      } catch {
        throw new Error("Expected a URL that ends in /v1, such as http://localhost:20128/v1");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("The URL must start with http:// or https://");
      return (u.origin + u.pathname).replace(/\/+$/, "");
    },
    model: (v) => {
      if (!/^[A-Za-z0-9][\w.:/-]*$/.test(v.trim())) throw new Error("Expected a model name without spaces, such as auto");
      return v.trim();
    },
    apiKey: (v) => (v.trim() === "" ? null : v.trim()),
    vision: bool,
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

/** What every setting does, in one line. `friend config keys` prints this; the README has the same list. */
export const KEY_HELP: Record<string, string> = {
  apiKey: "Anthropic API key, used when the model is \"claude\"",
  model: "Claude model name, used with the API key",
  provider: "which model answers: claude (API key), claude-code (your Claude subscription), ollama (on this PC) or openai (any OpenAI-compatible server, such as OmniRoute)",
  bind: "address Friend listens on: 127.0.0.1 is this PC only, 0.0.0.0 is your whole network (easier: friend lan on)",
  port: "the web port (easier: friend lan port N)",
  https: "true serves a secure https:// address (Friend makes its own certificate), so a phone may use the microphone (easier: friend lan https on)",
  publicUrl: "the address people use when Friend is behind your own domain, or empty",
  ownerName: "your name, shown on the profile badge (the shield) in the corner of the screen; empty shows Owner",
  roots: "folders Friend may read and write freely, separated by commas",
  allowedOrigins: "extra web addresses allowed to connect, separated by commas",
  allowedHosts: "extra host names that may reach Friend (for example my-pc), separated by commas",
  trustProxy: "true when Friend sits behind your own reverse proxy",
  "voice.enabled": "true or false: use speech at all",
  "voice.sttModel": "listening model: tiny, base, small, … (bigger is more accurate and slower)",
  "voice.ttsVoice": "speaking voice (easier: friend voice setup, or Settings)",
  "voice.language": "force a spoken language such as en, hi or mr, or empty to detect it (empty is best when you mix languages)",
  "voice.hindiVoice": "the voice that reads Hindi (Devanagari) text: hi_IN-priyamvada-medium, hi_IN-pratham-medium or hi_IN-rohan-medium; empty uses the main voice",
  "voice.marathiVoice": "the voice that reads Marathi (Devanagari) text: mr_IN-google-medium; empty uses the main voice",
  "voice.speakTyped": "true or false: also speak the replies to typed messages",
  "voice.accept": "0 to 1: a voice at or above this match is you",
  "voice.challenge": "0 to 1: a voice between this and accept must be confirmed with your PIN",
  "ollama.url": "address of the Ollama server, for example http://127.0.0.1:11434",
  "ollama.model": "the local model, for example qwen2.5:7b",
  "ollama.vision": "true or false: the local model can look at pictures",
  "ollama.contextTokens": "how much the local model remembers at once (1024 to 131072)",
  "openai.url": "address of an OpenAI-compatible server, ending in /v1; OmniRoute is http://localhost:20128/v1",
  "openai.model": "the model name that server knows; OmniRoute answers to auto",
  "openai.apiKey": "the server's API key, or empty when it asks for none (stored in your private config file)",
  "openai.vision": "true or false: that model can look at pictures",
  "claudeCode.model": "model for your Claude subscription: sonnet, haiku, opus or a full name",
  "claudeCode.command": "the command that starts Claude Code, if it is not on the PATH",
  "claudeCode.fallback": "ollama or none: what to use when Claude is unavailable",
};

const allKeys = () => [...Object.keys(PARSERS), ...Object.entries(GROUPS).flatMap(([g, f]) => Object.keys(f).map((k) => `${g}.${k}`))];

export const configKeys = (): string[] => allKeys();

export async function configCommand(args: string[], io: IO): Promise<number> {
  const [sub, key, ...valueParts] = args;
  if (sub === "keys") {
    for (const k of allKeys()) io.out(`${k.padEnd(24)} ${KEY_HELP[k] ?? ""}`);
    return 0;
  }
  if (sub !== "set" || !key) {
    io.err("Usage: friend config set <key> <value> | friend config keys");
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
    (cfg[group as "voice" | "ollama" | "openai" | "claudeCode"] as unknown as Record<string, unknown>)[field] = parse(value);
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
