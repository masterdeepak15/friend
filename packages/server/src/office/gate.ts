import type { OfficePolicy } from "@friend/protocol";
import { classifyShell } from "../policy/classify";
import { lexicalInsideRoots } from "../tools/registry";
import { isSimpleCommand } from "../policy/classify";

export type GateVerdict = { verdict: "allow" } | { verdict: "deny"; reason: string } | { verdict: "ask"; danger: boolean };

/**
 * Whether the assistant answers a question the gate did not settle, at the owner's chosen level. low: never, the owner is asked. medium: when the
 * command or tool is not dangerous. high: always. judge, self and hybrid: never here (the assistant answers each request, see office.ts). A refusal by the gate is never reaching here, so a high level still cannot go outside the
 * project folders, touch the files that decide what a worker may do, or run a command the owner listed as refused.
 */
export function assistantDecides(ask: { danger: boolean }, level: "low" | "medium" | "high" | "judge" | "self" | "hybrid"): boolean {
  return level === "high" || (level === "medium" && !ask.danger);
}

/** The fields of a tool call that can hold a path. A path in any of them must be inside the project. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "cwd"] as const;

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const PROTECTED_DIRS = new Set([".claude", ".git", ".vscode", ".husky"]);

/** A path written out in full (C:\x, C:/x, \\server\share or /x). Drive-relative (C:x), home (~), variable (%X%, $X) and stream (a:b) forms mean something other than what a plain join says. */
function plainAbsolute(p: string): boolean {
  if (/^[~%$]/.test(p)) return false;
  const rest = /^[a-zA-Z]:[\\/]/.test(p) ? p.slice(2) : p;
  return !rest.includes(":") && !/^[a-zA-Z]:/.test(p.replace(/^[a-zA-Z]:[\\/]/, "x"));
}

/** Files that decide what Claude Code does next: its settings and hooks, git hooks, MCP servers, editor tasks. */
function touchesProtected(p: string): boolean {
  const parts = p.toLowerCase().split(/[\\/]+/).filter(Boolean);
  return parts.some((s) => PROTECTED_DIRS.has(s)) || parts.at(-1) === ".mcp.json";
}

const READ_ONLY_COMMANDS = new Set(["ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "grep", "rg", "tree", "stat", "file", "du", "which", "where", "whoami", "date", "get-childitem", "get-content", "get-location", "select-string", "get-item", "test-path", "ffprobe"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "ls-files", "rev-parse", "blame"]);
/** Flags that make an otherwise reading command run something else or write a file. */
const RUNS_OR_WRITES = /^(--pre|--output|--ext-diff|--exec|-exec|-delete|-o$|-out|-c$)/i;

/**
 * A single plain command that only looks: listing, reading, searching, git status. No chaining, piping or redirection, and no path in it
 * that leaves the project folders. These are let through without asking, as a read of the same files by Read or Grep already is.
 */
export function readOnlyShell(command: string, folders: string[]): boolean {
  if (!isSimpleCommand(command.trim())) return false;
  const words = command.trim().split(/\s+/);
  const first = (words[0] ?? "").replace(/\.exe$/i, "").toLowerCase();
  const rest = words.slice(1).map((w) => w.replace(/^["']|["']$/g, ""));
  if (first === "git") {
    if (!READ_ONLY_GIT.has((rest[0] ?? "").toLowerCase())) return false;
  } else if (!READ_ONLY_COMMANDS.has(first)) return false;
  for (const w of rest) {
    if (RUNS_OR_WRITES.test(w)) return false;
    if (/^[~%]/.test(w) || /(^|[\\/])\.\.([\\/]|$)/.test(w)) return false;
    if (/^([a-zA-Z]:|[\\/])/.test(w) && (!plainAbsolute(w) || !lexicalInsideRoots(w, folders))) return false;
  }
  return true;
}

/**
 * Whether a worker's action may go ahead. Claude Code asks Friend about anything it would otherwise ask about; Friend answers:
 *  1. a path outside the project folder(s) is refused, whatever the allow-list says;
 *  2. a shell command that matches a deny pattern is refused;
 *  3. a tool the owner put on the allow-list goes ahead;
 *  4. anything else is put to the owner (with the PIN when the command looks dangerous).
 * A shell cannot be fully policed (a command can name any path), so it asks unless the owner allowed it, and a deny pattern still wins.
 */
export function decideAction(call: { tool: string; input: Record<string, unknown> }, ctx: { folders: string[]; policy: OfficePolicy; shellPatterns: string[] }): GateVerdict {
  const input = call.input && typeof call.input === "object" ? call.input : {};

  for (const field of PATH_FIELDS) {
    if (!(field in input) || input[field] === undefined) continue;
    const value = input[field];
    if (typeof value !== "string" || value.trim() === "") return { verdict: "deny", reason: `The ${field} is not a usable path.` };
    if (!plainAbsolute(value) || !lexicalInsideRoots(value, ctx.folders)) return { verdict: "deny", reason: "Outside the project folder." };
    if (!READ_TOOLS.has(call.tool) && touchesProtected(value)) return { verdict: "deny", reason: "A worker may not change the files that decide what it is allowed to do." };
  }

  // any tool that carries a command is a shell: Bash, and PowerShell on Windows, where Claude Code uses it instead
  const command = typeof input.command === "string" ? input.command : null;
  if (command !== null) {
    for (const pattern of ctx.policy.denyCommands) {
      try {
        if (new RegExp(pattern, "i").test(command)) return { verdict: "deny", reason: `The owner refuses commands that match ${pattern}.` };
      } catch {
        /* a pattern that is not a valid expression refuses nothing (the settings screen says so when it is saved) */
      }
    }
  }

  if (command !== null && readOnlyShell(command, ctx.folders)) return { verdict: "allow" };

  const danger = command !== null && classifyShell(command, ctx.shellPatterns) === "T3";
  if (ctx.policy.allowTools.includes(call.tool) && !danger) return { verdict: "allow" }; // a dangerous command asks for the PIN even when the shell was allowed
  return { verdict: "ask", danger };
}