import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Audit } from "./audit";
import { authorPlugin, type PluginSpec } from "./author";
import { readClaudePlugin, readMarketplace, type MarketplaceEntry, type TextReader } from "./claudePlugin";
import { parseRepoLink, type RepoRef } from "./github";
import type { Plugins } from "./plugins";

const KEEP_MS = 15 * 60_000;
const MAX_MARKETPLACES = 10;
const MAX_DOC_CHARS = 30_000;
const MAX_LISTED_FILES = 300;
const MAX_DOCS = 6;

export interface FetchedPlugin {
  id: string;
  name: string;
  folder: string;
  description: string;
  skills: { name: string; description: string }[];
  leftOut: { path: string; why: string }[];
  warnings: string[];
}

export interface Fetched {
  staging: string;
  repo: string;
  commit: string;
  /** The files of the repository (the first ones, when there are very many). */
  tree: string[];
  treeTotal: number;
  readme: string;
  docs: { path: string; text: string }[];
  plugins: FetchedPlugin[];
  marketplace?: string;
}

export interface SavedMarketplace {
  repo: string;
  name: string;
  plugins: MarketplaceEntry[];
}

interface Staged {
  repo: RepoRef;
  reader: TextReader;
  commit: string;
  paths: Set<string>;
  cache: Map<string, string>;
  results: { info: FetchedPlugin; spec: PluginSpec }[];
  expires: number;
}

export interface MarketDeps {
  dir: string;
  /** A new reader for each look: the reading limits belong to one look and the reading that follows it. */
  reader: () => TextReader;
  plugins: Plugins;
  /** Where the note about what was installed goes (the memory tree). Optional: without it no note is written. */
  memory?: { write(path: string, text: string, meta: { title: string; summary: string }): boolean };
  audit: Pick<Audit, "log">;
  clock?: () => number;
  /** Makes the id of a look; random unless a test needs to name it. */
  newId?: () => string;
}

const clean = (p: string) => p.replace(/^\.\//, "").replace(/^\.$/, "").replace(/^\/+|\/+$/g, "");
const join2 = (base: string, rest: string) => (base ? `${base}/${rest}` : rest);
const cut = (text: string) => (text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…(cut here; ask for the rest with plugins.read if you need it)` : text);

/**
 * Looks at a GitHub repository the way a person would (README, docs, folders), and installs the skills in it when the owner has said yes.
 * Nothing in the repository is ever run here; the text is kept in memory for fifteen minutes and then forgotten.
 */
export class Market {
  private staged = new Map<string, Staged>();

  constructor(private d: MarketDeps) {}

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  private sweep(): void {
    for (const [id, s] of this.staged) if (s.expires <= this.now()) this.staged.delete(id);
  }

  private get(staging: string): Staged {
    this.sweep();
    const s = this.staged.get(staging);
    if (!s) throw new Error("That look at the repository has expired or never existed; fetch it again.");
    return s;
  }

  async fetch(link: string): Promise<Fetched> {
    const repo = parseRepoLink(link);
    if (!repo) throw new Error("That is not a GitHub link. Give a link such as https://github.com/owner/repo, or owner/repo.");
    const reader = this.d.reader();
    const { commit, files } = await reader.tree(repo);
    const paths = new Set(files.map((f) => f.path));
    const base = clean(repo.folder ?? "");
    const at = (rest: string) => join2(base, rest);
    const texts = new Map<string, string>();
    const read = async (path: string): Promise<string | null> => {
      try {
        const t = await reader.file(repo, path);
        texts.set(path, t);
        return t;
      } catch {
        return null;
      }
    };

    let folders: string[];
    let marketplace: string | undefined;
    if (paths.has(at(".claude-plugin/marketplace.json"))) {
      const m = readMarketplace((await reader.file(repo, at(".claude-plugin/marketplace.json"))) ?? "");
      marketplace = m.name;
      folders = m.plugins.map((p) => join2(base, clean(p.source)));
    } else if (base) folders = [base];
    else {
      const nested = [...paths].filter((p) => /(^|\/)\.claude-plugin\/plugin\.json$/.test(p)).map((p) => p.replace(/\/?\.claude-plugin\/plugin\.json$/, ""));
      folders = nested.length ? nested.slice(0, 5) : [""];
    }

    const results: Staged["results"] = [];
    for (const folder of [...new Set(folders)]) {
      const r = await readClaudePlugin(reader, repo, folder);
      results.push({
        spec: r.spec,
        info: { id: r.spec.id, name: r.spec.name, folder, description: r.spec.description ?? "", skills: (r.spec.skills ?? []).map((s) => ({ name: s.name, description: s.description })), leftOut: r.leftOut, warnings: r.warnings },
      });
    }

    const rel = (p: string): string | null => (base ? (p.startsWith(`${base}/`) ? p.slice(base.length + 1) : null) : p);
    const readmePath = [...paths].find((p) => /^README(\.[A-Za-z]+)?$/i.test(rel(p) ?? ""));
    const readme = readmePath ? cut((await read(readmePath)) ?? "") : "";
    const docPaths = [...paths]
      .filter((p) => {
        const r = rel(p);
        return r !== null && (/^INSTALL[^/]*\.(md|txt)$/i.test(r) || /^(AGENTS|CLAUDE)\.md$/.test(r) || /^docs\/[^/]+\.md$/i.test(r));
      })
      .sort()
      .slice(0, MAX_DOCS);
    const docs: Fetched["docs"] = [];
    for (const p of docPaths) {
      const t = await read(p);
      if (t) docs.push({ path: p, text: cut(t) });
    }

    const id = (this.d.newId ?? (() => randomBytes(6).toString("hex")))();
    this.sweep();
    this.staged.set(id, { repo, reader, commit, paths, cache: texts, results, expires: this.now() + KEEP_MS });
    this.d.audit.log("agent", "plugins.fetch", { repo: `${repo.owner}/${repo.repo}`, commit, files: paths.size, plugins: results.length });
    const all = [...paths].sort();
    return {
      staging: id,
      repo: `${repo.owner}/${repo.repo}`,
      commit,
      tree: all.slice(0, MAX_LISTED_FILES),
      treeTotal: all.length,
      readme,
      docs,
      plugins: results.map((r) => r.info),
      ...(marketplace ? { marketplace } : {}),
    };
  }

  /** Another text file of the repository that was looked at. */
  async read(staging: string, path: string): Promise<string> {
    const s = this.get(staging);
    if (!s.paths.has(path)) throw new Error(`"${path}" is not in the repository.`);
    const hit = s.cache.get(path);
    if (hit !== undefined) return hit;
    const text = await s.reader.file(s.repo, path);
    s.cache.set(path, text);
    return text;
  }

  private source(s: Staged): string {
    return `github.com/${s.repo.owner}/${s.repo.repo}@${s.commit.slice(0, 7)}`;
  }

  private pick(s: Staged, pick: { plugin?: string; skills?: string[] } = {}): { info: FetchedPlugin; spec: PluginSpec }[] {
    let chosen = s.results;
    if (pick.plugin) {
      const want = pick.plugin.toLowerCase();
      chosen = s.results.filter((r) => r.info.id === want || r.info.name.toLowerCase() === want);
      if (!chosen.length) throw new Error(`There is no plugin called "${pick.plugin}" here. It has: ${s.results.map((r) => r.info.id).join(", ") || "nothing"}.`);
    }
    if (pick.skills) {
      const all = new Set(chosen.flatMap((r) => (r.spec.skills ?? []).map((k) => k.name)));
      const missing = pick.skills.find((k) => !all.has(k));
      if (missing) throw new Error(`There is no skill called "${missing}" in what was chosen.`);
      chosen = chosen.map((r) => ({ info: r.info, spec: { ...r.spec, skills: (r.spec.skills ?? []).filter((k) => pick.skills!.includes(k.name)) } })).filter((r) => r.spec.skills!.length);
    }
    return chosen;
  }

  /** Everything that would be installed, in full: the text the owner reads before saying yes. */
  preview(staging: string, pick?: { plugin?: string; skills?: string[] }): string {
    const s = this.get(staging);
    const chosen = this.pick(s, pick);
    const out = [`Install from ${this.source(s)}`];
    for (const r of chosen) {
      out.push(``, `Plugin ${r.spec.name} (${r.spec.id}) — ${r.spec.description || "no description"}`);
      for (const k of r.spec.skills ?? []) out.push(``, `Skill ${k.name} — ${k.description}`, k.text);
      if (!r.spec.skills?.length) out.push(`(no skills)`);
      for (const l of r.info.leftOut) out.push(`Left out: ${l.path} — ${l.why}`);
      for (const w of r.info.warnings) out.push(`Note: ${w}`);
    }
    return out.join("\n");
  }

  async import(staging: string, pick?: { plugin?: string; skills?: string[] }): Promise<{ ids: string[]; skills: string[] }> {
    const s = this.get(staging);
    const chosen = this.pick(s, pick).filter((r) => r.spec.skills?.length);
    if (!chosen.length) throw new Error("There is nothing to import here: no skills, commands or agents were found.");
    const source = this.source(s);
    for (const r of chosen) {
      const had = this.d.plugins.list().find((p) => p.id === r.spec.id);
      if (had && !had.source) throw new Error(`A plugin called "${r.spec.id}" is already installed and was not imported from GitHub, so Friend will not replace it.`);
    }
    const ids: string[] = [];
    const skills: string[] = [];
    for (const r of chosen) {
      const done = authorPlugin(this.d.plugins, join(this.d.dir, "drafts"), { ...r.spec, source });
      if (!done.ok) throw new Error(`"${r.spec.id}" was not installed: ${done.error}`);
      ids.push(r.spec.id);
      skills.push(...(r.spec.skills ?? []).map((k) => k.name));
      this.note(r.spec, source);
    }
    this.d.audit.log("agent", "plugins.import", { source, plugins: ids, skills });
    return { ids, skills };
  }

  private note(spec: PluginSpec, source: string): void {
    if (!this.d.memory) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const lines = [`# Skills from ${spec.name}`, ``, `Installed from ${source} on ${day}. ${spec.description ?? ""}`.trim(), ``, ...(spec.skills ?? []).map((k) => `- **${k.name}**: ${k.description} (load it with skill.use, plugin ${spec.id})`)];
    try {
      this.d.memory.write(`skills/${spec.id}.md`, lines.join("\n"), { title: `Skills from ${spec.name}`, summary: `I have the skills ${(spec.skills ?? []).map((k) => k.name).join(", ")} from ${source}.` });
    } catch {
      /* the note is a convenience; the install already worked */
    }
  }

  // ---- marketplaces ----

  private file(): string {
    return join(this.d.dir, "marketplaces.json");
  }

  marketplaces(): SavedMarketplace[] {
    try {
      const list = JSON.parse(readFileSync(this.file(), "utf8")) as SavedMarketplace[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private save(list: SavedMarketplace[]): void {
    mkdirSync(this.d.dir, { recursive: true });
    writeFileSync(this.file(), JSON.stringify(list, null, 2));
  }

  async addMarketplace(link: string): Promise<SavedMarketplace> {
    const repo = parseRepoLink(link);
    if (!repo) throw new Error("That is not a GitHub repository. Give owner/repo or a github.com link.");
    const reader = this.d.reader();
    const { files } = await reader.tree(repo);
    if (!files.some((f) => f.path === ".claude-plugin/marketplace.json")) throw new Error("That repository has no marketplace file (.claude-plugin/marketplace.json), so it is not a marketplace.");
    const m = readMarketplace(await reader.file(repo, ".claude-plugin/marketplace.json"));
    const name = `${repo.owner}/${repo.repo}`;
    const entry: SavedMarketplace = { repo: name, name: m.name, plugins: m.plugins };
    const list = this.marketplaces();
    const at = list.findIndex((x) => x.repo === name);
    if (at === -1 && list.length >= MAX_MARKETPLACES) throw new Error(`Friend keeps at most ten marketplaces; remove one first.`);
    if (at === -1) list.push(entry);
    else list[at] = entry;
    this.save(list);
    this.d.audit.log("agent", "plugins.marketplace_add", { repo: name, plugins: m.plugins.length });
    return entry;
  }

  removeMarketplace(repo: string): boolean {
    const list = this.marketplaces();
    const next = list.filter((x) => x.repo !== repo);
    if (next.length === list.length) return false;
    this.save(next);
    this.d.audit.log("agent", "plugins.marketplace_remove", { repo });
    return true;
  }
}
