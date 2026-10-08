import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The first folder that exists (and holds `mustContain`, when given). Friend finds its web files, bundled plugins and
 * Python speech code next to the program when it is installed from npm, and in the repository when it is run from source.
 */
export function firstExistingDir(candidates: (string | undefined | null)[], mustContain?: string): string | undefined {
  return candidates.find((c): c is string => !!c && existsSync(mustContain ? join(c, mustContain) : c));
}
