import { Plugins, inspectPlugin, openDb, firstExistingDir } from "@friend/server";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IO } from "../cli";

const USAGE = "Usage: friend plugin catalog | list | install <name|folder> [--yes] | enable <id> | disable <id> | remove <id>";

export interface PluginDeps {
  /** Folder with the bundled plugins (one folder per plugin). */
  catalogDir?: string;
}

function defaultCatalog(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return firstExistingDir([process.env.FRIEND_PLUGIN_CATALOG, resolve(here, "plugins"), resolve(here, "../../../../plugins")]) ?? resolve(here, "plugins");
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Add, switch off and remove extensions. Installing shows exactly what a plugin contains and asks first. */
export async function pluginCommand(args: string[], io: IO, deps: PluginDeps = {}): Promise<number> {
  const catalogDir = deps.catalogDir ?? defaultCatalog();
  const [sub, ...rest] = args;
  const flags = rest.filter((a) => a.startsWith("--"));
  const arg = rest.find((a) => !a.startsWith("--"));

  if (sub === "catalog") {
    const dirs = existsSync(catalogDir) ? readdirSync(catalogDir).filter((d) => statSync(join(catalogDir, d)).isDirectory()) : [];
    if (dirs.length === 0) io.out("The catalog is empty.");
    for (const d of dirs.sort()) {
      const r = inspectPlugin(join(catalogDir, d));
      if (!r.ok) {
        io.out(`${d}  (invalid: ${r.error})`);
        continue;
      }
      const m = r.manifest;
      io.out(`${m.id}  ${m.name} ${m.version}  [${count(m.tools.length, "tool")}, ${count(m.skills.length, "skill")}]  ${m.description}`);
    }
    return 0;
  }

  if (sub !== "list" && sub !== "install" && sub !== "enable" && sub !== "disable" && sub !== "remove") {
    io.err(USAGE);
    return 1;
  }

  const db = openDb(io.dataDir);
  try {
    const plugins = new Plugins(db, join(io.dataDir, "plugins"));

    if (sub === "list") {
      const all = plugins.list();
      if (all.length === 0) io.out("No plugins installed. See: friend plugin catalog");
      for (const p of all) {
        io.out(`${p.id}  ${p.version}  ${p.enabled ? "on" : "off"}  ${p.name}${p.error ? `  (cannot be used: ${p.error})` : ""}`);
      }
      return 0;
    }

    if (sub === "install") {
      if (!arg) {
        io.err(USAGE);
        return 1;
      }
      const inCatalog = !/[\\/]/.test(arg) && existsSync(join(catalogDir, arg));
      const source = inCatalog ? join(catalogDir, arg) : existsSync(resolve(arg)) ? resolve(arg) : null;
      if (!source) {
        io.err(`"${arg}" is not in the catalog and there is no such folder. See: friend plugin catalog`);
        return 1;
      }
      const r = inspectPlugin(source);
      if (!r.ok) {
        io.err(`That plugin cannot be installed: ${r.error}`);
        return 1;
      }
      const m = r.manifest;
      const upgrade = plugins.list().some((p) => p.id === m.id);
      io.out(`${upgrade ? "Upgrade" : "Plugin"}: ${m.name} ${m.version} (${m.id})`);
      if (m.description) io.out(m.description);
      if (m.skills.length) io.out(`Skills (${m.skills.length}): ${m.skills.map((s) => s.name).join(", ")}`);
      if (m.tools.length) {
        io.out(`Tools (${m.tools.length}): ${m.tools.map((t) => t.name).join(", ")}`);
        io.out("  Tools run in a Docker sandbox with no network and no access to your files, and ask for your approval every time.");
      }
      io.out(`Files: ${r.files}, ${Math.max(1, Math.round(r.bytes / 1024))} KB`);
      if (!flags.includes("--yes")) {
        const yes = /^y(es)?$/i.test((await io.ask("Install it? (y/N) ")).trim());
        if (!yes) {
          io.out("Not installed.");
          return 1;
        }
      }
      const done = plugins.install(source);
      if (!done.ok) {
        io.err(`That plugin cannot be installed: ${done.error}`);
        return 1;
      }
      io.out(done.upgraded ? `Upgraded ${done.id} to ${m.version} (kept your on/off choice).` : `Installed ${done.id} ${m.version}.`);
      return 0;
    }

    // enable | disable | remove
    if (!arg) {
      io.err(USAGE);
      return 1;
    }
    const known = plugins.list().some((p) => p.id === arg);
    if (!known) {
      io.err(`There is no plugin named ${arg}.`);
      return 1;
    }
    if (sub === "remove") plugins.remove(arg);
    else plugins.setEnabled(arg, sub === "enable");
    io.out(sub === "remove" ? `Removed ${arg}.` : `${arg} is now ${sub === "enable" ? "on" : "off"}.`);
    return 0;
  } finally {
    db.close();
  }
}
