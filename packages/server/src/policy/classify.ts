import type { Tier } from "@friend/protocol";

export function classifyShell(command: string, patterns: string[]): Tier {
  for (const p of patterns) {
    try {
      if (new RegExp(p, "i").test(command)) return "T3";
    } catch {
      /* ignore an invalid user-supplied pattern */
    }
  }
  return "T2";
}

/** True when the command is a single simple command with no chaining, piping, substitution or redirection. */
export function isSimpleCommand(command: string): boolean {
  return !/[;&|`<>\n\r]|\$\(/.test(command);
}
