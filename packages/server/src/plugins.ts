import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { z, type ZodTypeAny } from "zod";
import type { Db } from "./db";

export const MAX_SKILL_BYTES = 20 * 1024;
export const MAX_TOOL_BYTES = 50 * 1024;
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 1024 * 1024;
const MAX_ITEMS = 10;
const MAX_MANIFEST_BYTES = 64 * 1024;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROPERTY = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;
// Names go through the "."-to-"__" tool-name encoding, so they may contain neither dots nor underscores.
const Name = z.string().min(1).max(40).regex(NAME, "use lowercase letters, digits and single hyphens (1 to 40 characters)");

const PropertySchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    description: z.string().max(300).optional(),
    enum: z.array(z.string().max(100)).min(1).max(50).optional(),
  })
  .strict();

const ToolSchema = z
  .object({
    name: Name,
    description: z.string().min(1).max(500),
    language: z.enum(["python", "node", "shell"]),
    file: z.string().min(1).max(200),
    input: z.record(z.string(), PropertySchema).default({}),
    required: z.array(z.string()).default([]),
  })
  .strict();

const SkillSchema = z.object({ name: Name, description: z.string().min(1).max(300), file: z.string().min(1).max(200) }).strict();

const ManifestSchema = z
  .object({
    id: Name,
    name: z.string().min(1).max(80),
    version: z.string().min(1).max(40),
    description: z.string().max(500).default(""),
    skills: z.array(SkillSchema).max(MAX_ITEMS, { message: `A plugin can have at most ${MAX_ITEMS} skills.` }).default([]),
    tools: z.array(ToolSchema).max(MAX_ITEMS, { message: `A plugin can have at most ${MAX_ITEMS} tools.` }).default([]),
  })
  .strict();
export type PluginManifest = z.infer<typeof ManifestSchema>;

export interface PluginToolDef {
  /** The name the model sees: plugin.<id>.<tool>. */
  name: string;
  description: string;
  pluginId: string;
  toolName: string;
  language: "python" | "node" | "shell";
  code: string;
  input: ZodTypeAny;
  inputSchema: Record<string, unknown>;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  /** Why the plugin cannot be used, or null. */
  error: string | null;
  skills: { name: string; description: string }[];
  tools: { name: string; description: string }[];
}

interface Loaded {
  manifest: PluginManifest;
  skillText: Map<string, string>;
  toolCode: Map<string, string>;
  files: number;
  bytes: number;
}
type Inspected = ({ ok: true } & Loaded) | { ok: false; error: string };

/** The relative path of a file the manifest names, or null when it could point outside the plugin folder. */
function safeRelative(file: string): string[] | null {
  const norm = file.replaceAll("\\", "/");
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return null;
  const parts = norm.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts;
}

function scan(dir: string): { files: number; bytes: number } | string {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): string | null => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) return `The plugin contains a link (${entry}), which is not allowed.`;
      if (st.isDirectory()) {
        const err = walk(full);
        if (err) return err;
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        if (files > MAX_FILES) return `A plugin can have at most ${MAX_FILES} files.`;
        if (bytes > MAX_TOTAL_BYTES) return "A plugin can be at most 1 MB in total.";
      } else {
        return `The plugin contains something that is not a plain file (${entry}).`;
      }
    }
    return null;
  };
  const err = walk(dir);
  return err ?? { files, bytes };
}

function readInside(dir: string, file: string, limit: number): { ok: true; text: string } | { ok: false; error: string } {
  const parts = safeRelative(file);
  if (!parts) return { ok: false, error: `"${file}" must be a file inside the plugin folder.` };
  const full = resolve(dir, ...parts);
  if (relative(resolve(dir), full).startsWith("..")) return { ok: false, error: `"${file}" must be a file inside the plugin folder.` };
  if (!existsSync(full) || !lstatSync(full).isFile()) return { ok: false, error: `The file "${file}" does not exist.` };
  if (lstatSync(full).size > limit) return { ok: false, error: `"${file}" is too large (limit ${limit / 1024} KB).` };
  return { ok: true, text: readFileSync(full, "utf8") };
}

/** Checks a plugin folder completely and reads everything the agent could use from it. */
export function inspectPlugin(dir: string): Inspected {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return { ok: false, error: "That plugin folder does not exist." };
  const counted = scan(dir);
  if (typeof counted === "string") return { ok: false, error: counted };

  const manifestPath = join(dir, "plugin.json");
  if (!existsSync(manifestPath)) return { ok: false, error: "plugin.json is missing." };
  if (lstatSync(manifestPath).size > MAX_MANIFEST_BYTES) return { ok: false, error: "plugin.json is too large." };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { ok: false, error: "plugin.json is not valid JSON." };
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, error: `plugin.json is not valid: ${issue.path.length ? issue.path.join(".") + ": " : ""}${issue.message}` };
  }
  const manifest = parsed.data;

  const seen = (names: string[], kind: string): string | null => {
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    return dup ? `The ${kind} name "${dup}" is used twice.` : null;
  };
  const dup = seen(manifest.skills.map((s) => s.name), "skill") ?? seen(manifest.tools.map((t) => t.name), "tool");
  if (dup) return { ok: false, error: dup };

  const skillText = new Map<string, string>();
  for (const s of manifest.skills) {
    const r = readInside(dir, s.file, MAX_SKILL_BYTES);
    if (!r.ok) return r;
    skillText.set(s.name, r.text);
  }
  const toolCode = new Map<string, string>();
  for (const t of manifest.tools) {
    for (const key of Object.keys(t.input)) {
      if (!PROPERTY.test(key)) return { ok: false, error: `Invalid property name "${key}" in tool ${t.name} (letters, digits and underscores, starting with a letter or underscore).` };
    }
    const missing = t.required.find((k) => !(k in t.input));
    if (missing) return { ok: false, error: `Tool ${t.name}: required property "${missing}" is not declared.` };
    const r = readInside(dir, t.file, MAX_TOOL_BYTES);
    if (!r.ok) return r;
    toolCode.set(t.name, r.text);
  }
  return { ok: true, manifest, skillText, toolCode, files: counted.files, bytes: counted.bytes };
}

function toolDef(m: PluginManifest, t: PluginManifest["tools"][number], code: string): PluginToolDef {
  const shape: Record<string, ZodTypeAny> = {};
  const properties: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(t.input)) {
    let schema: ZodTypeAny =
      p.type === "string"
        ? p.enum
          ? z.enum(p.enum as [string, ...string[]])
          : z.string().max(10_000)
        : p.type === "integer"
          ? z.number().int()
          : p.type === "number"
            ? z.number()
            : z.boolean();
    if (!t.required.includes(key)) schema = schema.optional();
    shape[key] = schema;
    properties[key] = { type: p.type, ...(p.description ? { description: p.description } : {}), ...(p.enum ? { enum: p.enum } : {}) };
  }
  return {
    name: `plugin.${m.id}.${t.name}`,
    description: `[Plugin ${m.name}] ${t.description}`,
    pluginId: m.id,
    toolName: t.name,
    language: t.language,
    code,
    input: z.object(shape).strict(),
    inputSchema: { type: "object", properties, required: t.required, additionalProperties: false },
  };
}

export const isPluginId = (id: string): boolean => id.length >= 1 && id.length <= 40 && NAME.test(id);

export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  tools: number;
  skills: number;
  /** Set when the bundled plugin itself is broken; it cannot be installed. */
  error: string | null;
}

/** The bundled plugins: one folder each. Anything that does not validate is listed with its error instead of being hidden. */
export function listCatalog(dir: string): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => isPluginId(d) && lstatSync(join(dir, d)).isDirectory())
    .sort()
    .map((id) => {
      const r = inspectPlugin(join(dir, id));
      if (!r.ok) return { id, name: id, version: "", description: "", tools: 0, skills: 0, error: r.error };
      const m = r.manifest;
      return { id, name: m.name, version: m.version, description: m.description, tools: m.tools.length, skills: m.skills.length, error: null };
    });
}

/** Installed plugins: skills (instructions) and tools (programs for the code sandbox). Plugins are re-checked every time they load. */
export class Plugins {
  private cache: Map<string, Inspected> | null = null;

  constructor(
    private db: Db,
    private root: string,
    private clock: () => number = Date.now,
  ) {}

  inspect(srcDir: string): Inspected {
    return inspectPlugin(srcDir);
  }

  install(srcDir: string): { ok: true; id: string; upgraded: boolean } | { ok: false; error: string } {
    const r = inspectPlugin(srcDir);
    if (!r.ok) return r;
    const id = r.manifest.id;
    mkdirSync(this.root, { recursive: true });
    const staging = join(this.root, `.tmp-${randomUUID()}`);
    try {
      cpSync(srcDir, staging, { recursive: true, dereference: false });
      const dest = join(this.root, id);
      const upgraded = existsSync(dest);
      rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
      this.db
        .prepare("insert into plugins (id, enabled, installed_at) values (?, 1, ?) on conflict(id) do update set installed_at = excluded.installed_at")
        .run(id, this.clock());
      this.cache = null;
      return { ok: true, id, upgraded };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  reload(): void {
    this.cache = null;
  }

  private rows(): { id: string; enabled: boolean }[] {
    return (this.db.prepare("select id, enabled from plugins order by id").all() as { id: string; enabled: number }[]).map((r) => ({ id: r.id, enabled: r.enabled === 1 }));
  }

  private load(id: string): Inspected {
    this.cache ??= new Map();
    let hit = this.cache.get(id);
    if (!hit) {
      const dir = join(this.root, id);
      hit = existsSync(dir) ? inspectPlugin(dir) : { ok: false, error: "The plugin files are missing." };
      this.cache.set(id, hit);
    }
    return hit;
  }

  list(): PluginInfo[] {
    return this.rows().map(({ id, enabled }) => {
      const l = this.load(id);
      if (!l.ok) return { id, name: id, version: "", description: "", enabled, error: l.error, skills: [], tools: [] };
      const m = l.manifest;
      return {
        id,
        name: m.name,
        version: m.version,
        description: m.description,
        enabled,
        error: null,
        skills: m.skills.map((s) => ({ name: s.name, description: s.description })),
        tools: m.tools.map((t) => ({ name: t.name, description: t.description })),
      };
    });
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare("update plugins set enabled = ? where id = ?").run(enabled ? 1 : 0, id).changes > 0;
  }

  remove(id: string): boolean {
    const had = this.db.prepare("delete from plugins where id = ?").run(id).changes > 0;
    if (NAME.test(id)) rmSync(join(this.root, id), { recursive: true, force: true });
    this.cache = null;
    return had;
  }

  /** Plugins that are switched on and still valid. */
  private usable(): Loaded[] {
    const out: Loaded[] = [];
    for (const { id, enabled } of this.rows()) {
      if (!enabled) continue;
      const l = this.load(id);
      if (l.ok) out.push(l);
    }
    return out;
  }

  skills(): { plugin: string; name: string; description: string }[] {
    return this.usable().flatMap((l) => l.manifest.skills.map((s) => ({ plugin: l.manifest.id, name: s.name, description: s.description })));
  }

  skillText(plugin: string, name: string): string | null {
    return this.usable().find((l) => l.manifest.id === plugin)?.skillText.get(name) ?? null;
  }

  toolDefs(): PluginToolDef[] {
    return this.usable().flatMap((l) => l.manifest.tools.map((t) => toolDef(l.manifest, t, l.toolCode.get(t.name)!)));
  }

  tool(fullName: string): PluginToolDef | undefined {
    return this.toolDefs().find((t) => t.name === fullName);
  }
}
