import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugins } from "./plugins";

export interface PluginSpec {
  id: string;
  name: string;
  description?: string;
  skills?: { name: string; description: string; text: string }[];
  tools?: {
    name: string;
    description: string;
    language: "python" | "node" | "shell";
    code: string;
    parameters?: Record<string, { type: "string" | "number" | "integer" | "boolean"; description?: string; enum?: string[] }>;
    required?: string[];
  }[];
}

const EXT = { python: "py", node: "js", shell: "sh" } as const;

/** 1.0.0 for a new plugin; one patch higher than the installed version when it is replaced. */
function nextVersion(previous: string | undefined): string {
  const m = previous ? /^(\d+)\.(\d+)\.(\d+)$/.exec(previous) : null;
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : "1.0.0";
}

/**
 * Writes a plugin the AI composed into a scratch folder and installs it through the same checks as any plugin (names,
 * sizes, paths), switches it on, and reads the plugins again so its skills and tools can be used straight away.
 * The caller has already had the owner approve with the PIN; this never runs the plugin's code.
 */
export function authorPlugin(plugins: Plugins, scratchRoot: string, spec: PluginSpec): { ok: true; id: string; upgraded: boolean; skills: number; tools: number } | { ok: false; error: string } {
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "draft-"));
  try {
    const previous = plugins.list().find((p) => p.id === spec.id)?.version;
    const manifest = {
      id: spec.id,
      name: spec.name,
      version: nextVersion(previous),
      description: spec.description ?? "",
      skills: (spec.skills ?? []).map((s) => ({ name: s.name, description: s.description, file: `skills/${s.name}.md` })),
      tools: (spec.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        language: t.language,
        file: `tools/${t.name}.${EXT[t.language]}`,
        input: t.parameters ?? {},
        required: t.required ?? [],
      })),
    };
    // file names come from names that are checked as part of the manifest; refuse anything else before writing a byte
    for (const f of [...manifest.skills, ...manifest.tools]) {
      if (!/^(skills|tools)\/[a-z0-9]+(-[a-z0-9]+)*\.(md|py|js|sh)$/.test(f.file)) return { ok: false, error: `"${f.name}" is not a valid name. Use lowercase letters, digits and single hyphens.` };
    }
    mkdirSync(join(dir, "skills"), { recursive: true });
    mkdirSync(join(dir, "tools"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
    spec.skills?.forEach((s, i) => writeFileSync(join(dir, manifest.skills[i]!.file), s.text));
    spec.tools?.forEach((t, i) => writeFileSync(join(dir, manifest.tools[i]!.file), t.code));

    const installed = plugins.install(dir);
    if (!installed.ok) return { ok: false, error: installed.error };
    plugins.setEnabled(installed.id, true);
    plugins.reload();
    const now = plugins.list().find((p) => p.id === installed.id);
    if (!now || now.error) return { ok: false, error: now?.error ?? "The plugin did not load." };
    return { ok: true, id: installed.id, upgraded: installed.upgraded, skills: now.skills.length, tools: now.tools.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
