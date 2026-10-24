import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The memory tree: Markdown notes in folders, as deep as the topic needs, with one INDEX.md in every folder that lists what is in it.
 * The program fixes no branch names. The assistant (or the owner) makes the folders it wants; the tree only guarantees that everything
 * can be found by walking from the root INDEX.md: every folder is listed in its parent's index and every note in its folder's index.
 */

export const INDEX_FILE = "INDEX.md";
const MAX_DEPTH = 6;
const MAX_NOTES = 2000;
const MAX_NOTE_CHARS = 6000;
const LONG_NOTE_CHARS = 1200;
const MAX_TITLE = 80;
const MAX_SUMMARY = 160;
/** A folder with more entries than this should be grouped into sub-folders. */
export const CROWDED = 30;
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LINK = /^- \[([^\]]*)\]\(([^)]*)\)(?: — (.*))?$/;

export type Source = "owner" | "agent" | "import";
export interface Entry {
  kind: "note" | "folder";
  title: string;
  /** Relative to the folder whose index lists it; a folder ends with "/". */
  target: string;
  summary: string;
}
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
export interface Found {
  path: string;
  title: string;
  summary: string;
}
export interface Problem {
  kind: "unlisted" | "dead-link" | "no-index" | "unlisted-folder" | "dead-related";
  path: string;
}

const today = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const humanize = (segment: string): string => segment.replace(/\.md$/, "").replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());

const SECRETS: RegExp[] = [
  /\b(pass(word|wd|code)?|pin|otp|cvv|secret|token|api[ _-]?key|private[ _-]?key)\b[^.\n]{0,20}?(\bis\b|\bare\b|=|:)\s*\S{3,}/i,
  /\b(?:\d[ -]?){13,19}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Whether a text looks like it holds a password, a PIN, a key, a card number or a one-time code. Memory never keeps those. */
export function looksSecret(text: string): boolean {
  return SECRETS.some((re) => re.test(text));
}

/** A path inside the tree, made safe: relative, lowercase segments of letters, digits and dashes, no ".." and not too deep. */
export function cleanPath(raw: unknown): { ok: true; parts: string[]; isNote: boolean } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Give a path." };
  const text = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^memory\//, "");
  if (text === "") return { ok: true, parts: [], isNote: false };
  const parts = text.split("/").filter((p) => p !== "");
  if (parts.length > MAX_DEPTH) return { ok: false, error: `Notes can be at most ${MAX_DEPTH} folders deep.` };
  const last = parts[parts.length - 1]!;
  const isNote = last.endsWith(".md");
  for (const [i, p] of parts.entries()) {
    const name = i === parts.length - 1 && isNote ? p.slice(0, -3) : p;
    if (name === "INDEX" && i === parts.length - 1 && isNote) continue;
    if (!SEGMENT.test(name)) return { ok: false, error: `"${p}" is not a usable name: use lowercase letters, digits and dashes (up to 41 characters).` };
  }
  return { ok: true, parts, isNote };
}

interface Note {
  title: string;
  summary: string;
  updated: string;
  source: string;
  /** Paths from the root of other notes this one is about, kept in the header; the body shows them as links. */
  related: string[];
  body: string;
}

function parseNote(text: string, fallbackTitle: string): Note {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  const head: Record<string, string> = {};
  let body = text.replace(/\r\n/g, "\n");
  if (m) {
    for (const line of m[1]!.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    body = m[2]!;
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1];
  const related = (head.related ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // the links under "Related" are drawn from the header each time a note is saved, so they are not part of what the note says
  body = body.replace(/\n+## Related\n(?:- .*\n?)*\s*$/, "\n");
  return { title: head.title || heading || fallbackTitle, summary: head.summary ?? "", updated: head.updated ?? "", source: head.source ?? "", related, body: body.replace(/^\n+/, "").replace(/\s+$/, "") };
}

function renderNote(n: Note, links: string[] = []): string {
  const rel = n.related.length ? `related: ${n.related.join(", ")}\n` : "";
  const section = links.length ? `\n\n## Related\n${links.join("\n")}` : "";
  return `---\ntitle: ${n.title}\nsummary: ${n.summary}\nupdated: ${n.updated}\nsource: ${n.source}\n${rel}---\n\n${n.body.trim()}${section}\n`;
}

/** A link from a note in `fromFolder` to the note at `to` (a path from the root), the way an editor can follow it. */
function relativeLink(fromFolder: string[], to: string[]): string {
  let i = 0;
  while (i < fromFolder.length && i < to.length - 1 && fromFolder[i] === to[i]) i++;
  return [...Array(fromFolder.length - i).fill(".."), ...to.slice(i)].join("/");
}

/** An index file: free text above (kept as the owner or the assistant wrote it), then one link line per entry. */
function parseIndex(text: string): { head: string[]; entries: Entry[] } {
  const head: string[] = [];
  const entries: Entry[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = LINK.exec(line);
    if (m) entries.push({ kind: m[2]!.endsWith("/") ? "folder" : "note", title: m[1]!, target: m[2]!, summary: m[3] ?? "" });
    else head.push(line);
  }
  while (head.length && head[head.length - 1] === "") head.pop();
  return { head, entries };
}

function renderIndex(head: string[], entries: Entry[]): string {
  const lines = entries.map((e) => `- [${e.title}](${e.target})${e.summary ? ` — ${e.summary}` : ""}`);
  return `${head.join("\n")}\n\n${lines.join("\n")}\n`;
}

/** A file name for a quick note: its first words, with a number added when that name is taken. */
export function inboxName(text: string, taken: (name: string) => boolean): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "") || "note";
  let name = base;
  for (let i = 2; taken(name); i++) name = `${base}-${i}`;
  return name;
}

/** The root index cut to fit the prompt: whole lines only, with a pointer to the rest. */
export function capIndex(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf("\n");
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}\n(more entries: open the root with memory.read)`;
}

export class MemoryTree {
  constructor(
    readonly root: string,
    private clock: () => number = Date.now,
  ) {}

  /** Creates the root and its index when they are not there yet. */
  ensure(): void {
    mkdirSync(this.root, { recursive: true });
    const idx = join(this.root, INDEX_FILE);
    if (!existsSync(idx)) this.writeFile(idx, renderIndex(["# Memory", "", "Everything I know about the owner and their world. Each line below is a folder or a note; open one to go deeper."], []));
  }

  private abs(parts: string[]): string {
    return join(this.root, ...parts);
  }

  /** True when the path, or any folder above it, is a link: the tree never follows one. */
  private hasLink(parts: string[]): boolean {
    let p = this.root;
    for (const part of parts) {
      p = join(p, part);
      try {
        if (lstatSync(p).isSymbolicLink()) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private writeFile(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  }

  private readIndexOf(folder: string[]): { head: string[]; entries: Entry[] } {
    const file = this.abs([...folder, INDEX_FILE]);
    if (!existsSync(file)) return { head: [`# ${folder.length ? humanize(folder[folder.length - 1]!) : "Memory"}`], entries: [] };
    return parseIndex(readFileSync(file, "utf8"));
  }

  private saveIndexOf(folder: string[], idx: { head: string[]; entries: Entry[] }): void {
    this.writeFile(this.abs([...folder, INDEX_FILE]), renderIndex(idx.head, idx.entries));
  }

  /** Adds or updates one line in a folder's index, and makes sure the folder itself is listed in its parent's index, all the way to the root. */
  private list(folder: string[], entry: Entry): void {
    const idx = this.readIndexOf(folder);
    const at = idx.entries.findIndex((e) => e.target === entry.target);
    if (at >= 0) idx.entries[at] = { ...idx.entries[at]!, ...entry };
    else idx.entries.push(entry);
    this.saveIndexOf(folder, idx);
    if (folder.length > 0) {
      const parent = folder.slice(0, -1);
      const name = folder[folder.length - 1]!;
      const siblings = this.readIndexOf(parent);
      if (!siblings.entries.some((e) => e.target === `${name}/`)) this.list(parent, { kind: "folder", title: humanize(name), target: `${name}/`, summary: "" });
      else if (!existsSync(this.abs([...parent, INDEX_FILE]))) this.saveIndexOf(parent, siblings);
    }
  }

  private unlist(folder: string[], target: string): void {
    if (!existsSync(this.abs([...folder, INDEX_FILE]))) return;
    const idx = this.readIndexOf(folder);
    idx.entries = idx.entries.filter((e) => e.target !== target);
    this.saveIndexOf(folder, idx);
  }

  rootIndex(): string {
    this.ensure();
    return readFileSync(join(this.root, INDEX_FILE), "utf8").replace(/\r\n/g, "\n");
  }

  /** Whether a path (with the .md) is already used. */
  has(raw: string): boolean {
    const p = cleanPath(raw);
    return p.ok && existsSync(this.abs(p.parts));
  }

  /** Counts every note (not index files). */
  count(): number {
    let n = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE) n++;
      }
    };
    if (existsSync(this.root)) walk(this.root);
    return n;
  }

  /** A note's text, or a folder's index. An empty path is the root. */
  read(raw: unknown): Result<{ kind: "note" | "folder"; path: string; text: string }> {
    const p = cleanPath(raw);
    if (!p.ok) return p;
    this.ensure();
    if (this.hasLink(p.parts)) return { ok: false, error: "That path is a link, which memory does not follow." };
    if (p.isNote) {
      const file = this.abs(p.parts);
      if (!existsSync(file)) return { ok: false, error: `There is no note at ${p.parts.join("/")}.` };
      return { ok: true, kind: "note", path: p.parts.join("/"), text: readFileSync(file, "utf8").replace(/\r\n/g, "\n") };
    }
    const dir = this.abs(p.parts);
    if (!existsSync(dir)) return { ok: false, error: `There is no folder at ${p.parts.join("/") || "the root"}.` };
    const file = this.abs([...p.parts, INDEX_FILE]);
    return { ok: true, kind: "folder", path: p.parts.join("/"), text: existsSync(file) ? readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "(this folder has no index yet)" };
  }

  /**
   * Saves a note, making the folders it needs and listing it (and every new folder on the way) in the indexes. Creating a folder is just
   * writing a note into it: the assistant decides the topic names.
   */
  write(raw: unknown, text: string, o: { title?: string; summary?: string; source?: Source; folderSummary?: string; related?: string[] } = {}): Result<{ path: string; hint?: string }> {
    const p = cleanPath(raw);
    if (!p.ok) return p;
    if (!p.isNote || p.parts[p.parts.length - 1] === INDEX_FILE) return { ok: false, error: "A note's path ends in .md, for example people/priya.md. INDEX.md is kept by memory itself." };
    if (this.hasLink(p.parts)) return { ok: false, error: "That path is a link, which memory does not follow." };
    const body = text.replace(/\r\n/g, "\n").trim();
    if (!body) return { ok: false, error: "There is nothing to save." };
    if (looksSecret(body)) return { ok: false, error: "That looks like a password, a PIN, a key, a card number or a code. Memory does not keep those." };
    if (body.length > MAX_NOTE_CHARS) return { ok: false, error: `That note is too long (${body.length} characters; the limit is ${MAX_NOTE_CHARS}). Split it into smaller notes.` };
    this.ensure();
    const file = this.abs(p.parts);
    const existed = existsSync(file);
    if (!existed && this.count() >= MAX_NOTES) return { ok: false, error: "Memory is full. Forget something first." };
    const folder = p.parts.slice(0, -1);
    const name = p.parts[p.parts.length - 1]!;
    const prev = existed ? parseNote(readFileSync(file, "utf8"), humanize(name)) : null;
    const title = oneLine(o.title ?? prev?.title ?? humanize(name), MAX_TITLE);
    const summary = oneLine(o.summary ?? prev?.summary ?? body.split("\n")[0]!.replace(/^#+\s*/, ""), MAX_SUMMARY);
    const related = o.related !== undefined ? this.validRelated(o.related, p.parts.join("/")) : (prev?.related ?? []).filter((r) => this.noteExists(r));
    this.writeFile(file, renderNote({ title, summary, updated: today(this.clock()), source: o.source ?? prev?.source ?? "agent", related, body }, this.linkLines(folder, related)));
    this.list(folder, { kind: "note", title, target: name, summary });
    if (o.folderSummary && folder.length > 0) {
      const parent = this.readIndexOf(folder.slice(0, -1));
      const at = parent.entries.findIndex((e) => e.target === `${folder[folder.length - 1]}/`);
      if (at >= 0) {
        parent.entries[at]!.summary = oneLine(o.folderSummary, MAX_SUMMARY);
        this.saveIndexOf(folder.slice(0, -1), parent);
      }
    }
    const crowd = this.readIndexOf(folder).entries.length;
    const hints: string[] = [];
    if (body.length > LONG_NOTE_CHARS) hints.push("This note is long: split it into smaller notes.");
    if (crowd > CROWDED) hints.push(`This folder now has ${crowd} entries: group related ones into sub-folders.`);
    return { ok: true, path: p.parts.join("/"), ...(hints.length ? { hint: hints.join(" ") } : {}) };
  }

  private noteExists(path: string): boolean {
    const p = cleanPath(path);
    return p.ok && p.isNote && p.parts[p.parts.length - 1] !== INDEX_FILE && !this.hasLink(p.parts) && existsSync(this.abs(p.parts));
  }

  /** Paths of notes that exist, are not the note itself, and are each listed once. */
  private validRelated(list: string[], self: string): string[] {
    const out: string[] = [];
    for (const r of list) {
      const p = cleanPath(r);
      if (!p.ok || !p.isNote) continue;
      const path = p.parts.join("/");
      if (path !== self && !out.includes(path) && this.noteExists(path)) out.push(path);
    }
    return out.slice(0, 12);
  }

  private linkLines(fromFolder: string[], related: string[]): string[] {
    return related.map((r) => {
      const parts = r.split("/");
      const note = parseNote(readFileSync(this.abs(parts), "utf8"), humanize(parts[parts.length - 1]!));
      return `- [${note.title}](${relativeLink(fromFolder, parts)})${note.summary ? ` — ${note.summary}` : ""}`;
    });
  }

  /** Sets the one-line description shown beside a folder in its parent's index. */
  describe(raw: unknown, summary: string): Result {
    const p = cleanPath(raw);
    if (!p.ok) return p;
    if (p.isNote || p.parts.length === 0 || !existsSync(this.abs(p.parts))) return { ok: false, error: "That is not a folder in memory." };
    this.list(p.parts.slice(0, -1), { kind: "folder", title: humanize(p.parts[p.parts.length - 1]!), target: `${p.parts[p.parts.length - 1]}/`, summary: oneLine(summary, MAX_SUMMARY) });
    return { ok: true };
  }

  /** Every note (path, title, summary, related), reading the files. For tidying, and for the notes' links. */
  notes(): { path: string; title: string; summary: string; related: string[]; body: string }[] {
    const out: { path: string; title: string; summary: string; related: string[]; body: string }[] = [];
    const walk = (dir: string, parts: string[]): void => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(join(dir, e.name), [...parts, e.name]);
        else if (e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE) {
          const n = parseNote(readFileSync(join(dir, e.name), "utf8"), humanize(e.name));
          out.push({ path: [...parts, e.name].join("/"), title: n.title, summary: n.summary, related: n.related, body: n.body });
        }
      }
    };
    walk(this.root, []);
    return out;
  }

  /** After a note or folder moved or was deleted, notes that pointed at it follow it (or drop the pointer). */
  private fixRelated(from: string, to: string | null): void {
    const prefix = from.endsWith(".md") ? null : `${from}/`;
    for (const n of this.notes()) {
      const next = n.related.flatMap((r) => (r === from ? (to ? [to] : []) : prefix && r.startsWith(prefix) ? (to ? [`${to}/${r.slice(prefix.length)}`] : []) : [r]));
      if (JSON.stringify(next) === JSON.stringify(n.related)) continue;
      this.write(n.path, n.body, { related: next, source: "agent" });
    }
  }

  /** Deletes a note, or a folder with everything in it, and takes it off its index. The root cannot be deleted. */
  remove(raw: unknown): Result<{ removed: number }> {
    const p = cleanPath(raw);
    if (!p.ok) return p;
    if (p.parts.length === 0) return { ok: false, error: "The root of memory cannot be deleted." };
    if (p.parts[p.parts.length - 1] === INDEX_FILE) return { ok: false, error: "INDEX.md is kept by memory itself." };
    if (this.hasLink(p.parts)) return { ok: false, error: "That path is a link, which memory does not follow." };
    const target = this.abs(p.parts);
    if (!existsSync(target)) return { ok: false, error: `There is nothing at ${p.parts.join("/")}.` };
    const removed = p.isNote ? 1 : this.countUnder(p.parts);
    rmSync(target, { recursive: true, force: true });
    const folder = p.parts.slice(0, -1);
    const name = p.parts[p.parts.length - 1]!;
    this.unlist(folder, p.isNote ? name : `${name}/`);
    this.fixRelated(p.parts.join("/"), null);
    return { ok: true, removed };
  }

  private countUnder(parts: string[]): number {
    let n = 0;
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".md") && e.name !== INDEX_FILE) n++;
      }
    };
    walk(this.abs(parts));
    return n;
  }

  /** Moves a note to another folder or name; both indexes follow. A folder moves with everything in it. */
  move(from: unknown, to: unknown): Result<{ path: string }> {
    const a = cleanPath(from);
    const b = cleanPath(to);
    if (!a.ok) return a;
    if (!b.ok) return b;
    if (a.parts.length === 0 || b.parts.length === 0) return { ok: false, error: "Give a note or folder to move and where to." };
    if (a.isNote !== b.isNote) return { ok: false, error: "A note moves to a note path (.md) and a folder to a folder path." };
    if (this.hasLink(a.parts) || this.hasLink(b.parts)) return { ok: false, error: "That path is a link, which memory does not follow." };
    const src = this.abs(a.parts);
    const dst = this.abs(b.parts);
    if (!existsSync(src)) return { ok: false, error: `There is nothing at ${a.parts.join("/")}.` };
    if (existsSync(dst)) return { ok: false, error: `${b.parts.join("/")} already exists.` };
    if (!a.isNote && b.parts.join("/").startsWith(`${a.parts.join("/")}/`)) return { ok: false, error: "A folder cannot move into itself." };
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    const fromFolder = a.parts.slice(0, -1);
    const fromName = a.parts[a.parts.length - 1]!;
    const toFolder = b.parts.slice(0, -1);
    const toName = b.parts[b.parts.length - 1]!;
    const old = this.readIndexOf(fromFolder).entries.find((e) => e.target === (a.isNote ? fromName : `${fromName}/`));
    this.unlist(fromFolder, a.isNote ? fromName : `${fromName}/`);
    if (a.isNote) {
      const note = parseNote(readFileSync(dst, "utf8"), humanize(toName));
      this.list(toFolder, { kind: "note", title: note.title, target: toName, summary: note.summary });
    } else {
      this.list(toFolder, { kind: "folder", title: old?.title ?? humanize(toName), target: `${toName}/`, summary: old?.summary ?? "" });
    }
    this.fixRelated(a.parts.join("/"), b.parts.join("/"));
    if (a.isNote) this.write(b.parts.join("/"), parseNote(readFileSync(dst, "utf8"), humanize(toName)).body, { source: "agent" }); // its own links are drawn again from where it is now
    return { ok: true, path: b.parts.join("/") };
  }

  /** Notes whose title, summary or text contain every word of the query, best first. */
  search(query: string, limit = 10): Found[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const hits: (Found & { score: number })[] = [];
    const walk = (dir: string, parts: string[]): void => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(join(dir, e.name), [...parts, e.name]);
        else if (e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE) {
          const note = parseNote(readFileSync(join(dir, e.name), "utf8"), humanize(e.name));
          const head = `${note.title} ${note.summary}`.toLowerCase();
          const all = `${head} ${note.body.toLowerCase()}`;
          if (!words.every((w) => all.includes(w))) continue;
          hits.push({ path: [...parts, e.name].join("/"), title: note.title, summary: note.summary, score: words.filter((w) => head.includes(w)).length });
        }
      }
    };
    walk(this.root, []);
    return hits
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map(({ score: _s, ...f }) => f);
  }

  /** Every folder and note, walking down from the root by the indexes, with how deep each is. */
  outline(): { path: string; kind: "note" | "folder"; title: string; summary: string; depth: number }[] {
    const out: { path: string; kind: "note" | "folder"; title: string; summary: string; depth: number }[] = [];
    const walk = (folder: string[]): void => {
      if (!existsSync(this.abs([...folder, INDEX_FILE]))) return;
      for (const e of this.readIndexOf(folder).entries) {
        const path = [...folder, e.target.replace(/\/$/, "")].join("/");
        out.push({ path: e.kind === "folder" ? `${path}/` : path, kind: e.kind, title: e.title, summary: e.summary, depth: folder.length });
        if (e.kind === "folder" && folder.length < MAX_DEPTH) walk([...folder, e.target.replace(/\/$/, "")]);
      }
    };
    walk([]);
    return out;
  }

  /** Deletes every note and folder and starts the root index again. Returns how many notes there were. */
  clearAll(): number {
    const n = this.count();
    rmSync(this.root, { recursive: true, force: true });
    this.ensure();
    return n;
  }

  /** What is off in the tree: things that cannot be found by walking from the root. */
  check(): Problem[] {
    this.ensure();
    const problems: Problem[] = [];
    const walk = (folder: string[]): void => {
      const dir = this.abs(folder);
      const hasIndex = existsSync(join(dir, INDEX_FILE));
      if (!hasIndex) problems.push({ kind: "no-index", path: folder.join("/") });
      const listed = hasIndex ? parseIndex(readFileSync(join(dir, INDEX_FILE), "utf8")).entries : [];
      const seen = new Set<string>();
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          seen.add(`${e.name}/`);
          if (!listed.some((l) => l.target === `${e.name}/`)) problems.push({ kind: "unlisted-folder", path: [...folder, e.name].join("/") });
          walk([...folder, e.name]);
        } else if (e.isFile() && e.name.endsWith(".md") && e.name !== INDEX_FILE) {
          const key = e.name;
          seen.add(key);
          if (!listed.some((l) => l.target === key)) problems.push({ kind: "unlisted", path: [...folder, e.name].join("/") });
        }
      }
      for (const l of listed) if (!seen.has(l.target)) problems.push({ kind: "dead-link", path: [...folder, l.target].join("/") });
    };
    walk([]);
    for (const n of this.notes()) for (const r of n.related) if (!this.noteExists(r)) problems.push({ kind: "dead-related", path: `${n.path} -> ${r}` });
    return problems;
  }

  /** Puts the tree right: lists what is unlisted, drops dead links, makes missing indexes. Returns how many things it fixed. */
  repair(): number {
    const problems = this.check();
    for (const p of problems) {
      if (p.kind === "dead-related") {
        const [note] = p.path.split(" -> ");
        const n = this.notes().find((x) => x.path === note);
        if (n) this.write(n.path, n.body, { related: n.related, source: "agent" });
        continue;
      }
      const parts = p.path.split("/").filter(Boolean);
      if (p.kind === "dead-link") {
        const target = parts[parts.length - 1]!;
        this.unlist(parts.slice(0, -1), target);
      } else if (p.kind === "unlisted") {
        const note = parseNote(readFileSync(this.abs(parts), "utf8"), humanize(parts[parts.length - 1]!));
        this.list(parts.slice(0, -1), { kind: "note", title: oneLine(note.title, MAX_TITLE), target: parts[parts.length - 1]!, summary: oneLine(note.summary || note.body.split("\n")[0] || "", MAX_SUMMARY) });
      } else if (p.kind === "unlisted-folder") {
        this.list(parts.slice(0, -1), { kind: "folder", title: humanize(parts[parts.length - 1]!), target: `${parts[parts.length - 1]}/`, summary: "" });
      } else if (p.kind === "no-index") {
        this.saveIndexOf(parts, this.readIndexOf(parts));
      }
    }
    return problems.length;
  }
}
