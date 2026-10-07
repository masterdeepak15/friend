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

/**
 * True when the command is a single plain command: no chaining, piping, redirection, variables,
 * subexpressions, script blocks or comma lists. PowerShell evaluates `( )`, `@( )`, `{ }` and `$x`
 * even inside the arguments of a native program, so all of them disqualify a command from rules.
 */
export function isSimpleCommand(command: string): boolean {
  return command.length > 0 && !/[;&|`<>\n\r(){}$,@]/.test(command);
}
