import type { PluginSpec } from "./author";
import type { RepoRef } from "./github";
import { MAX_SKILL_BYTES } from "./plugins";

/** What the reader needs from GitHub; `GithubReader` satisfies it and tests can stand in. */
export interface TextReader {
  tree(r: RepoRef): Promise<{ commit: string; files: { path: string; size: number }[] }>;
  file(r: RepoRef, path: string, maxBytes?: number): Promise<string>;
}

const MAX_SKILLS = 10;

export interface MarketplaceEntry {
  name: string;
  /** A folder of the same repository, as written in the marketplace file ("./plugin"). */
  source: string;
  description: string;
}

/** Reads a Claude Code `marketplace.json`. Plugins that live elsewhere than a folder of this repository are skipped. */
export function readMarketplace(text: string): { name: string; plugins: MarketplaceEntry[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file is not a marketplace (it is not valid JSON).");
  }
  const o = data as { name?: unknown; plugins?: unknown } | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.plugins)) throw new Error("That file is not a marketplace (it has no list of plugins).");
  const plugins: MarketplaceEntry[] = [];
  for (const p of o.plugins as Record<string, unknown>[]) {
    if (!p || typeof p.name !== "string" || typeof p.source !== "string") continue;
    plugins.push({ name: p.name.slice(0, 80), source: p.source, description: typeof p.description === "string" ? p.description.slice(0, 300) : "" });
  }
  return { name: typeof o.name === "string" ? o.name.slice(0, 80) : "marketplace", plugins };
}

/** A markdown file with optional `---` frontmatter. Returns null when there is nothing in it. */
export function parseSkillFile(text: string): { name: string; description: string; body: string } | null {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!src.trim()) return null;
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { name: "", description: "", body: src.trim() };
  const fields: Record<string, string> = {};
  const lines = m[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === "" || value === ">" || value === "|" || value === ">-" || value === "|-") {
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) more.push(lines[++i]!.trim());
      value = more.join(" ");
    }
    fields[kv[1]!] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return { name: fields.name ?? "", description: fields.description ?? "", body: src.slice(m[0].length).trim() };
}

/** Lowercase letters, digits and single hyphens, at most `max` characters; empty when nothing is left. */
export function slug(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const TOOLS = /\b(ffmpeg|docker|playwright|puppeteer|imagemagick|yt-dlp)\b/gi;
const INSTALLS = /\b(?:(?:npm|pnpm|yarn)\s+(?:install|i|add)|pip3?\s+install|brew\s+install|apt(?:-get)?\s+install|git\s+clone|cargo\s+install|go\s+install)\b/gi;
const FILES = /\b(?:scripts|references|assets)\/[\w./-]+/g;

function warningsFor(skill: string, text: string): string[] {
  const out: string[] = [];
  const tools = [...new Set([...text.matchAll(TOOLS)].map((m) => m[1]!.toLowerCase()))];
  if (tools.length) out.push(`"${skill}" expects ${tools.join(", ")}, which Friend may not have.`);
  const installs = [...new Set([...text.matchAll(INSTALLS)].map((m) => m[0].replace(/\s+/g, " ")))];
  if (installs.length) out.push(`"${skill}" asks to run ${installs.join(", ")}. Friend would only do that if you say yes each time.`);
  const files = [...new Set([...text.matchAll(FILES)].map((m) => m[0]))];
  if (files.length) out.push(`"${skill}" refers to ${files.join(", ")}, which was not imported (only the text of the skill is). Friend can read them first and ask you before running anything.`);
  if (/skill base directory/i.test(text)) out.push(`"${skill}" talks about its "skill base directory"; an imported skill has none.`);
  return out;
}

function clean(folder: string): string {
  return folder.replace(/^\.\//, "").replace(/^\.$/, "").replace(/^\/+|\/+$/g, "");
}

/** One line of plain text: a name or description from a repository cannot start a line of its own on the approval card. */
export const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

const firstLine = (body: string) => (body.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "").slice(0, 300);

/**
 * Reads one Claude Code plugin folder of a repository into a Friend plugin spec: skills as they are, commands as `cmd-…` skills and
 * agents as `agent-…` skills. Hooks, MCP servers and scripts are never imported; they are listed with the reason.
 */
export async function readClaudePlugin(
  reader: TextReader,
  repo: RepoRef,
  folder: string,
): Promise<{ spec: PluginSpec; leftOut: { path: string; why: string }[]; warnings: string[] }> {
  const base = clean(folder);
  const at = (rest: string) => (base ? `${base}/${rest}` : rest);
  const { files } = await reader.tree(repo);
  const inside = files.filter((f) => !base || f.path === base || f.path.startsWith(`${base}/`));
  const rel = (p: string) => (base ? p.slice(base.length + 1) : p);

  let manifest: { name?: unknown; description?: unknown } = {};
  if (inside.some((f) => f.path === at(".claude-plugin/plugin.json"))) {
    try {
      manifest = JSON.parse(await reader.file(repo, at(".claude-plugin/plugin.json"))) as typeof manifest;
    } catch {
      /* a broken plugin.json is not a reason to refuse the skills */
    }
  }

  const found: { kind: "skill" | "cmd" | "agent"; path: string; fallback: string; size: number }[] = [];
  for (const f of inside) {
    const r = rel(f.path);
    let m: RegExpExecArray | null;
    if ((m = /^skills\/([^/]+)\/SKILL\.md$/.exec(r))) found.push({ kind: "skill", path: f.path, fallback: m[1]!, size: f.size });
    else if (r === "SKILL.md") found.push({ kind: "skill", path: f.path, fallback: base.split("/").pop() || repo.repo, size: f.size });
    else if ((m = /^commands\/([^/]+)\.md$/.exec(r))) found.push({ kind: "cmd", path: f.path, fallback: m[1]!, size: f.size });
    else if ((m = /^agents\/([^/]+)\.md$/.exec(r))) found.push({ kind: "agent", path: f.path, fallback: m[1]!, size: f.size });
  }
  const order = { skill: 0, cmd: 1, agent: 2 } as const;
  found.sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path));

  const leftOut: { path: string; why: string }[] = [];
  const warnings: string[] = [];
  const skills: NonNullable<PluginSpec["skills"]> = [];
  const used = new Set<string>();
  for (const f of found) {
    if (f.size > MAX_SKILL_BYTES) {
      leftOut.push({ path: f.path, why: `too large (${Math.ceil(f.size / 1024)} KB, limit ${MAX_SKILL_BYTES / 1024})` });
      continue;
    }
    if (skills.length >= MAX_SKILLS) {
      warnings.push(`Only ${MAX_SKILLS} skills are taken from one plugin; the rest were left out.`);
      break;
    }
    const parsed = parseSkillFile(await reader.file(repo, f.path, MAX_SKILL_BYTES * 2));
    if (!parsed || !parsed.body) {
      leftOut.push({ path: f.path, why: "empty" });
      continue;
    }
    const prefix = f.kind === "cmd" ? "cmd-" : f.kind === "agent" ? "agent-" : "";
    const stem = f.kind === "skill" ? slug(parsed.name) || slug(f.fallback) : f.kind === "cmd" ? slug(f.fallback) : slug(parsed.name) || slug(f.fallback);
    const root = slug(`${prefix}${stem || "skill"}`) || "skill";
    let name = root;
    for (let n = 2; used.has(name); n++) name = `${root.slice(0, 40 - String(n).length - 1)}-${n}`;
    used.add(name);
    skills.push({ name, description: oneLine(parsed.description || firstLine(parsed.body) || name, 300), text: parsed.body });
    warnings.push(...warningsFor(name, parsed.body));
  }
  if (!skills.length && !found.length) warnings.push("There are no skills, commands or agents in this folder, so there is nothing to import.");

  const seen = new Set<string>();
  const left = (path: string, why: string) => {
    if (!seen.has(path)) {
      seen.add(path);
      leftOut.push({ path, why });
    }
  };
  for (const f of inside) {
    const parts = rel(f.path).split("/");
    const i = parts.indexOf("scripts");
    if (i !== -1 && i < parts.length - 1) left(at(parts.slice(0, i + 1).join("/")), "Scripts are never installed. Friend can read them first and ask you before it runs anything.");
    if (parts[0] === "hooks" && parts.length > 1) left(at("hooks"), "Hooks run programs on a machine by themselves, so they are never installed.");
    if (rel(f.path) === "hooks.json") left(f.path, "Hooks run programs on a machine by themselves, so they are never installed.");
    if (rel(f.path) === ".mcp.json") left(f.path, "MCP servers can be added as connectors one by one, each with your approval; this import does not do it.");
  }

  const rawName = oneLine(typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : base.split("/").pop() || repo.repo, 80);
  const spec: PluginSpec = {
    id: slug(rawName) || "imported",
    name: rawName,
    description: typeof manifest.description === "string" ? oneLine(manifest.description, 500) : "",
    skills,
  };
  return { spec, leftOut, warnings };
}
