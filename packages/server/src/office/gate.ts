import type { OfficePolicy } from "@friend/protocol";
import { classifyShell } from "../policy/classify";
import { lexicalInsideRoots } from "../tools/registry";

export type GateVerdict = { verdict: "allow" } | { verdict: "deny"; reason: string } | { verdict: "ask"; danger: boolean };

/** The fields of a tool call that can hold a path. A path in any of them must be inside the project. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "cwd"] as const;

/**
 * Whether a worker's action may go ahead. Claude Code asks Friend about anything it would otherwise ask about; Friend answers:
 *  1. a path outside the project folder(s) is refused, whatever the allow-list says;
 *  2. a shell command that matches a deny pattern is refused;
 *  3. a tool the owner put on the allow-list goes ahead;
 *  4. anything else is put to the owner (with the PIN when the command looks dangerous).
 * Bash cannot be fully policed (a command can name any path), so it asks unless the owner allowed it, and a deny pattern still wins.
 */
export function decideAction(call: { tool: string; input: Record<string, unknown> }, ctx: { folders: string[]; policy: OfficePolicy; shellPatterns: string[] }): GateVerdict {
  const input = call.input && typeof call.input === "object" ? call.input : {};

  for (const field of PATH_FIELDS) {
    if (!(field in input) || input[field] === undefined) continue;
    const value = input[field];
    if (typeof value !== "string" || value.trim() === "") return { verdict: "deny", reason: `The ${field} is not a usable path.` };
    if (!lexicalInsideRoots(value, ctx.folders)) return { verdict: "deny", reason: "Outside the project folder." };
  }

  const command = call.tool === "Bash" && typeof input.command === "string" ? input.command : null;
  if (command !== null) {
    for (const pattern of ctx.policy.denyCommands) {
      try {
        if (new RegExp(pattern, "i").test(command)) return { verdict: "deny", reason: `The owner refuses commands that match ${pattern}.` };
      } catch {
        /* a pattern that is not a valid expression refuses nothing (the settings screen says so when it is saved) */
      }
    }
  }

  if (ctx.policy.allowTools.includes(call.tool)) return { verdict: "allow" };
  return { verdict: "ask", danger: command !== null && classifyShell(command, ctx.shellPatterns) === "T3" };
}