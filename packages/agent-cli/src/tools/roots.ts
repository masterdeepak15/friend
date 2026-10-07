import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const isWin = process.platform === "win32";
const norm = (p: string) => (isWin ? p.toLowerCase() : p);

/** lstat sees dangling links, which existsSync reports as missing. */
const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Marks a path that cannot be resolved safely; it is never inside any root. */
const UNRESOLVABLE = "\0unresolvable:";

/** realpath of the deepest existing ancestor, with the not-yet-existing tail re-attached. */
function realish(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  while (!exists(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(cur.slice(parent.length).replace(/^[\\/]+/, ""));
    cur = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(cur);
  } catch {
    return UNRESOLVABLE + abs; // a dangling link: where it leads is unknown, so treat it as outside
  }
  return tail.length ? resolve(real, ...tail) : real;
}

function within(root: string, target: string): boolean {
  if (target.startsWith(UNRESOLVABLE)) return false;
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
