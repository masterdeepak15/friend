import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorConfig } from "../connectors/store";

/** One skill a worker can be given: a folder with a SKILL.md. */
export interface SkillInfo {
  /** What it is called when it is given out: `name`, or `plugin:name` for a skill that comes with a plugin. */
  id: string;
  plugin: string;
  name: string;
  description: string;
  dir: string;
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const subdirs = (p: string): string[] => {
  try {
    return readdirSync(p).filter((n) => isDir(join(p, n)));
  } catch {
    return [];
  }
};

/** The `description:` line of a SKILL.md's front matter, on one line. */
function descriptionOf(file: string): string {
  try {
    const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    const d = m ? /^description:\s*(.*)$/m.exec(m[1]!) : null;
    return (d?.[1] ?? "").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim().slice(0, 400);
  } catch {
    return "";
  }
}

function skillsIn(dir: string, plugin: string): SkillInfo[] {
  return subdirs(dir).flatMap((name) => {
    const file = join(dir, name, "SKILL.md");
    return existsSync(file) ? [{ id: plugin ? `${plugin}:${name}` : name, plugin, name, description: descriptionOf(file), dir: join(dir, name) }] : [];
  });
}

const newest = (names: string[]): string | undefined => [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);

/**
 * Where skills are looked for. The owner's own list wins; with none, Claude Code's own folder: the one named by CLAUDE_CONFIG_DIR, or
 * .claude in the home folder.
 */
export function skillRootsOf(configured: string[], env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  if (configured.length > 0) return configured;
  return [env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude")];
}

/**
 * The skills found under each root: the root's own skills folder (and the root itself when its folders hold skills), and the skills of the
 * newest version of each installed plugin (the layout Claude Code keeps in plugins/cache/<source>/<plugin>/<version>/skills).
 */
export function discoverSkills(roots: string[]): SkillInfo[] {
  const found = new Map<string, SkillInfo>();
  const add = (list: SkillInfo[]) => {
    for (const s of list) if (!found.has(s.id)) found.set(s.id, s);
  };
  for (const root of roots) {
    add(skillsIn(join(root, "skills"), ""));
    add(skillsIn(root, ""));
    const cache = join(root, "plugins", "cache");
    for (const source of subdirs(cache)) {
      for (const plugin of subdirs(join(cache, source))) {
        const version = newest(subdirs(join(cache, source, plugin)));
        if (version) add(skillsIn(join(cache, source, plugin, version, "skills"), plugin));
      }
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether a name is on a list of allowed names: exactly, or by a trailing * (a lone * is everything). */
export function matchesAllow(list: readonly string[], id: string): boolean {
  return list.some((p) => p === id || p === "*" || (p.endsWith("*") && id.startsWith(p.slice(0, -1))));
}

export const PLUGIN_NAME = "office-skills";

/** Makes the plugin folder one worker is started with: just the skills it was given, copied in. A new folder each time, so a skill taken away is gone. */
export function buildSkillPlugin(dest: string, skills: SkillInfo[]): void {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dest, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0", description: "The skills the Office gave this worker." }));
  const used = new Set<string>();
  for (const s of skills) {
    const folder = used.has(s.name) ? `${s.plugin || "skill"}-${s.name}` : s.name;
    used.add(s.name);
    used.add(folder);
    cpSync(s.dir, join(dest, "skills", folder), { recursive: true });
  }
}

/** One connector as Claude Code's MCP configuration writes it. */
export function mcpEntry(c: ConnectorConfig): Record<string, unknown> {
  return c.kind === "stdio" ? { command: c.command, args: c.args, ...(Object.keys(c.env).length ? { env: c.env } : {}) } : { type: "http", url: c.url, ...(Object.keys(c.headers).length ? { headers: c.headers } : {}) };
}

/** Tool names carry the server's name with anything but letters and digits turned into _. */
export const toolServer = (tool: string): string | null => (tool.startsWith("mcp__") ? (tool.split("__")[1] ?? null) : null);
export const normServer = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, "_");
