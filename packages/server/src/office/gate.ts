import type { OfficePolicy } from "@friend/protocol";
import { classifyShell } from "../policy/classify";
import { lexicalInsideRoots } from "../tools/registry";

export type GateVerdict = { verdict: "allow" } | { verdict: "deny"; reason: string } | { verdict: "ask"; danger: boolean };

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

  const danger = command !== null && classifyShell(command, ctx.shellPatterns) === "T3";
  if (ctx.policy.allowTools.includes(call.tool) && !danger) return { verdict: "allow" }; // a dangerous command asks for the PIN even when the shell was allowed
  return { verdict: "ask", danger };
}