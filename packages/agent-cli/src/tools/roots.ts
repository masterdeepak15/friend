import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const isWin = process.platform === "win32";
const norm = (p: string) => (isWin ? p.toLowerCase() : p);

/** realpath of the deepest existing ancestor, with the not-yet-existing tail re-attached. */
function realish(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ""));
    cur = parent;
  }
  const real = realpathSync.native(cur);
  return tail.length ? resolve(real, ...tail) : real;
}

function within(root: string, target: string): boolean {
  const rel = relative(norm(root), norm(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/** Resolve `p` (relative paths are taken relative to the first root) and report whether it lies inside any root. */
export function resolveInRoots(p: string, roots: string[]): { abs: string; inside: boolean } {
  const base = roots[0] ?? process.cwd();
  const abs = realish(resolve(base, p));
  const inside = roots.some((r) => within(realish(resolve(r)), abs));
  return { abs, inside };
}
