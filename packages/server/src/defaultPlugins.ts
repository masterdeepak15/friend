import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCatalog } from "./plugins";

const MARKER = "default-plugins.json";

function offeredBefore(dir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { offered?: unknown };
    return Array.isArray(raw.offered) ? raw.offered.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Installs the plugins that come with Friend and that the assistant should have from the start (the screen-design skill), once.
 * What the owner removes later stays removed: a plugin is offered one time only, and that is remembered in the data folder.
 * Returns the ids that were installed now.
 */
export function installDefaults(plugins: { install(srcDir: string): { ok: boolean }; list(): { id: string }[] }, catalogDir: string, dataDir: string, ids: readonly string[]): string[] {
  const offered = new Set(offeredBefore(dataDir));
  const have = new Set(plugins.list().map((p) => p.id));
  const catalog = new Map(listCatalog(catalogDir).map((c) => [c.id, c]));
  const done: string[] = [];
  let changed = false;
  for (const id of ids) {
    if (offered.has(id)) continue;
    const entry = catalog.get(id);
    if (!entry || entry.error) continue; // not in this build: offer it again when it is
    offered.add(id);
    changed = true;
    if (!have.has(id) && plugins.install(join(catalogDir, id)).ok) done.push(id);
  }
  if (changed && existsSync(dataDir)) writeFileSync(join(dataDir, MARKER), JSON.stringify({ offered: [...offered].sort() }));
  return done;
}
