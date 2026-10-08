import { loadConfig, saveConfig } from "@friend/server";
import type { IO } from "../cli";
import { defaultRunner, type Runner } from "./voice";

export interface ClaudeDeps {
  run?: Runner;
}

interface Check {
  installed: boolean;
  version?: string;
  signedIn?: boolean;
  account?: string;
}

async function check(run: Runner, command: string): Promise<Check> {
  const v = await run(command, ["--version"]);
  if (v.code !== 0) return { installed: false };
  const version = v.stdout.trim().split(/\r?\n/)[0];
  const a = await run(command, ["auth", "status"]);
  let signedIn = a.code === 0;
  let account: string | undefined;
  try {
    const o = JSON.parse(a.stdout) as { loggedIn?: boolean; email?: string };
    if (typeof o.loggedIn === "boolean") signedIn = o.loggedIn;
    if (typeof o.email === "string") account = o.email;
  } catch {
    // older versions print plain text; the exit code is all there is
  }
  return { installed: true, version, signedIn, account };
}

const NOT_INSTALLED = "Claude Code is not installed. Install it from https://claude.com/claude-code, then run this again.";
const NOT_SIGNED_IN = "Claude Code is not signed in. Open a terminal, run: claude   then sign in with your Claude account, and run this again.";

async function statusCommand(io: IO, run: Runner): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  io.out(`Provider:       ${cfg.provider}`);
  const c = await check(run, cfg.claudeCode.command);
  if (!c.installed) {
    io.out(`Claude Code:    not found (${cfg.claudeCode.command}). Run: friend claude setup`);
    return 0;
  }
  io.out(`Claude Code:    ${c.version}`);
  io.out(`Signed in:      ${c.signedIn ? `yes${c.account ? ` (${c.account})` : ""}` : "no. Run: friend claude setup"}`);
  io.out(`Model:          ${cfg.claudeCode.model}`);
  io.out(`If unavailable: ${cfg.claudeCode.fallback === "ollama" ? "answer with the local model (Ollama)" : "show an error"}`);
  return 0;
}

async function setupCommand(args: string[], io: IO, run: Runner): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  const c = await check(run, cfg.claudeCode.command);
  if (!c.installed) {
    io.err(NOT_INSTALLED);
    return 1;
  }
  if (!c.signedIn) {
    io.err(NOT_SIGNED_IN);
    return 1;
  }
  io.out(`Claude Code ${c.version} is installed and signed in${c.account ? ` as ${c.account}` : ""}.`);
  if (args.includes("--use")) {
    cfg.provider = "claude-code";
    saveConfig(cfg);
    io.out("Friend now answers through Claude Code, using your Claude subscription. Restart Friend to apply.");
  } else {
    io.out("Use it with: friend config set provider claude-code");
  }
  io.out("Note: this uses your plan's usage limits. If they run out, Friend falls back to the local model while that is switched on (friend config set claudeCode.fallback ollama|none).");
  return 0;
}

export async function claudeCommand(args: string[], io: IO, deps: ClaudeDeps = {}): Promise<number> {
  const run = deps.run ?? defaultRunner;
  switch (args[0]) {
    case "status":
      return statusCommand(io, run);
    case "setup":
      return setupCommand(args.slice(1), io, run);
    default:
      io.err("Usage: friend claude status | friend claude setup [--use]");
      return 1;
  }
}
