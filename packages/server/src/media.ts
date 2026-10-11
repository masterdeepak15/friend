import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Db } from "./db";

/** What `file.present` hands back: the object to show, or why the file cannot be shown. */
export type Presented = { ok: true; type: string; props: Record<string, unknown>; summary: string } | { ok: false; error: string };

const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml" };
const VIDEO: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac" };
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const CODE_LANG: Record<string, string> = {
  txt: "text", log: "text", json: "json", yaml: "yaml", yml: "yaml", xml: "xml", html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
  py: "python", go: "go", rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", rb: "ruby", php: "php", sh: "shell", ps1: "powershell", bat: "batch", sql: "sql", toml: "toml", ini: "ini", env: "text",
};

/** What is never sent from the PC to a chat: programs and scripts. */
const NOT_SENT = new Set(["exe", "bat", "cmd", "com", "msi", "scr", "ps1", "vbs", "lnk", "dll", "sh", "jar", "reg"]);
const DOC_MIME: Record<string, string> = { pdf: "application/pdf", txt: "text/plain", csv: "text/csv", md: "text/markdown", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const MAX_SEND = 100 * 1024 * 1024;
const MAX_IMAGE = 40 * 1024 * 1024;
const MAX_VIDEO = 8 * 1024 * 1024 * 1024;
const MAX_PDF = 300 * 1024 * 1024;
const MAX_TEXT = 200_000;
const MAX_CSV_ROWS = 200;

/** A line-by-line reader for comma separated values, with quoted cells. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_CSV_ROWS + 1) return rows;
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const insideOf = (dir: string, path: string): boolean => {
  const rel = relative(process.platform === "win32" ? dir.toLowerCase() : dir, process.platform === "win32" ? path.toLowerCase() : path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep + sep));
};

/**
 * Files the owner approved to be shown. A file gets a random id; the screen asks for it at /api/media/<id> (signed-in
 * browsers only). Nothing inside Friend's own data folder can ever be shown, whoever approves.
 */
export class MediaStore {
  constructor(
    private db: Db,
    private dataDir: string,
    private clock: () => number = Date.now,
  ) {}

  lookup(id: string): { path: string; mime: string; size: number } | null {
    const r = this.db.prepare("select path, mime, size from media where id = ?").get(id) as { path: string; mime: string; size: number } | undefined;
    return r ?? null;
  }

  /** Ids still wanted (shown on screen or pinned); every other grant older than a day is forgotten. */
  prune(keep: Set<string>): void {
    const rows = this.db.prepare("select id, created_at c from media").all() as { id: string; c: number }[];
    const cutoff = this.clock() - 24 * 3600 * 1000;
    for (const r of rows) if (!keep.has(r.id) && r.c < cutoff) this.db.prepare("delete from media where id = ?").run(r.id);
  }

  private grant(path: string, mime: string, size: number): string {
    const existing = this.db.prepare("select id from media where path = ?").get(path) as { id: string } | undefined;
    if (existing) {
      this.db.prepare("update media set mime = ?, size = ?, created_at = ? where id = ?").run(mime, size, this.clock(), existing.id);
      return existing.id;
    }
    const id = randomBytes(16).toString("hex");
    this.db.prepare("insert into media (id, path, mime, size, created_at) values (?, ?, ?, ?, ?)").run(id, path, mime, size, this.clock());
    return id;
  }

  /** A file the assistant wants to send to the owner's chat: checked here (it must exist, be a real file, not be Friend's own data, not a program). */
  async sendable(rawPath: string): Promise<{ ok: true; path: string; name: string; mime: string; size: number; kind: "image" | "audio" | "video" | "document" } | { ok: false; error: string }> {
    if (!isAbsolute(rawPath)) return { ok: false, error: "Give the full path of the file, for example D:\\Pictures\\photo.png." };
    let real: string;
    try {
      real = await fs.realpath(resolve(rawPath));
    } catch {
      return { ok: false, error: "That file does not exist." };
    }
    if (insideOf(await fs.realpath(this.dataDir).catch(() => this.dataDir), real)) return { ok: false, error: "Friend's own data folder cannot be sent." };
    const stat = await fs.stat(real).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, error: "That path is not a file." };
    const name = basename(real);
    const ext = extname(real).slice(1).toLowerCase();
    if (NOT_SENT.has(ext)) return { ok: false, error: `Friend cannot send .${ext} files.` };
    if (stat.size === 0) return { ok: false, error: "That file is empty." };
    if (stat.size > MAX_SEND) return { ok: false, error: `That file is too big to send (${Math.round(stat.size / 1048576)} MB).` };
    const mime = IMAGE[ext] ?? VIDEO[ext] ?? DOC_MIME[ext] ?? "application/octet-stream";
    const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "document";
    return { ok: true, path: real, name, mime, size: stat.size, kind };
  }

  async present(rawPath: string, title?: string): Promise<Presented> {
    if (!isAbsolute(rawPath)) return { ok: false, error: "Give the full path of the file, for example D:\\Pictures\\photo.png." };
    let real: string;
    try {
      real = await fs.realpath(resolve(rawPath));
    } catch {
      return { ok: false, error: "That file does not exist." };
    }
    if (insideOf(await fs.realpath(this.dataDir).catch(() => this.dataDir), real)) return { ok: false, error: "Friend's own data folder cannot be shown." };
    const stat = await fs.stat(real).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, error: "That path is not a file." };

    const name = basename(real);
    const ext = extname(real).slice(1).toLowerCase();
    const label = title?.trim() || name;
    const tooBig = (limit: number, what: string) => (stat.size > limit ? { ok: false as const, error: `That ${what} is too large to show (${Math.round(stat.size / 1048576)} MB).` } : null);

    if (IMAGE[ext]) {
      const big = tooBig(MAX_IMAGE, "image");
      if (big) return big;
      const id = this.grant(real, IMAGE[ext]!, stat.size);
      return { ok: true, type: "image", props: { title: label, src: `/api/media/${id}` }, summary: `Showing the image ${name}.` };
    }
    if (VIDEO[ext]) {
      const big = tooBig(MAX_VIDEO, "file");
      if (big) return big;
      const id = this.grant(real, VIDEO[ext]!, stat.size);
      return { ok: true, type: "video", props: { title: label, src: `/api/media/${id}` }, summary: `Showing ${name}.` };
    }
    if (ext === "pdf") {
      const big = tooBig(MAX_PDF, "PDF");
      if (big) return big;
      const id = this.grant(real, "application/pdf", stat.size);
      return { ok: true, type: "pdf", props: { title: label, src: `/api/media/${id}` }, summary: `Showing the PDF ${name}.` };
    }
    if (MARKDOWN.has(ext) || ext === "csv" || CODE_LANG[ext]) {
      const handle = await fs.open(real, "r");
      let text: string;
      try {
        const buf = Buffer.alloc(Math.min(stat.size, MAX_TEXT));
        await handle.read(buf, 0, buf.length, 0);
        text = buf.toString("utf8");
      } finally {
        await handle.close();
      }
      if (text.includes("\u0000")) return { ok: false, error: "That file is not text, so it cannot be shown." };
      const cut = stat.size > MAX_TEXT;
      const note = cut ? `\n\n[Only the first ${MAX_TEXT} characters are shown.]` : "";
      if (MARKDOWN.has(ext)) return { ok: true, type: "markdown", props: { title: label, text: text + note }, summary: `Showing ${name}.${cut ? " It is long, so only the start is shown." : ""}` };
      if (ext === "csv") {
        const rows = parseCsv(text);
        const [head = [], ...body] = rows;
        return { ok: true, type: "table", props: { title: label, columns: head, rows: body.slice(0, MAX_CSV_ROWS) }, summary: `Showing ${name} as a table (${Math.min(body.length, MAX_CSV_ROWS)} rows).` };
      }
      return { ok: true, type: "code", props: { title: label, language: CODE_LANG[ext], code: text + note.replace(/^\n\n/, "\n") }, summary: `Showing ${name}.${cut ? " It is long, so only the start is shown." : ""}` };
    }
    return { ok: false, error: `Friend cannot show .${ext || "?"} files. It can show images, GIFs, video, sound, PDF, Markdown, text, CSV and code.` };
  }
}
