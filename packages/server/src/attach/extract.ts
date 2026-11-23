import { readEntry, readZip } from "./zip";

/** What a file turned into for the assistant: its text, or a picture it can look at, or the reason it cannot be read. */
export type Extracted = { ok: true; kind: "text"; text: string } | { ok: true; kind: "image"; mime: string; data: string } | { ok: false; error: string };

/** The most text kept from one file; the rest is cut and the assistant is told. */
export const MAX_TEXT_CHARS = 2_000_000;
/** Nothing in an attached file is ever run: it is only read. These limits keep a crafted file from using up the PC while it is read. */
const MAX_ENTRY_BYTES = 30 * 1024 * 1024;
/** All the files of one Word, Excel or PowerPoint document together, once unpacked. */
const ZIP_BUDGET_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 100;
const MAX_SHEETS = 50;
const MAX_SLIDES = 500;
export const MAX_PDF_PAGES = 300;
const PDF_TIMEOUT_MS = 20_000;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "srt", "vtt", "tex", "rst",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat", "sql", "css", "scss", "vue", "svelte", "swift", "r", "lua", "pl",
]);
const IMAGES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** Whether the first bytes really are what the picture's ending says (a text file named .png is not sent on as a picture). */
function looksLike(mime: string, b: Buffer): boolean {
  if (mime === "image/png") return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === "image/gif") return b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"));
  return b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
}

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString("utf8");
  return bytes.toString("utf8");
}

const codePoint = (n: number): string => {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
};
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** &amp; &#65; &#x41; and the few named ones. Nothing else is ever expanded (there is no XML parser to fool). */
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => (e[0] === "#" ? codePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (NAMED[e] ?? m)));
const tidy = (s: string): string => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function htmlText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(body));
}

/** An Office document: a zip archive read one file at a time, with one budget for everything unpacked from it. */
interface Zip {
  names: string[];
  read(name: string): string | null;
}
function openZip(bytes: Buffer): Zip {
  const entries = readZip(bytes);
  let left = ZIP_BUDGET_BYTES;
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.size > left) throw new Error("the document unpacks to too much");
      const out = readEntry(bytes, e, Math.min(MAX_ENTRY_BYTES, left));
      left -= out.length;
      return out.toString("utf8");
    },
  };
}

function docxText(z: Zip): string {
  const doc = z.read("word/document.xml");
  if (doc === null) throw new Error("not a Word document");
  const xml = doc
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "")
    .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, "")
    .replace(/<w:tab\s*\/>/g, "\t")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "");
  return tidy(decodeEntities(xml));
}

const textsOf = (xml: string): string => decodeEntities([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
const columnOf = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function xlsxText(z: Zip): string {
  const book = z.read("xl/workbook.xml");
  if (book === null) throw new Error("not an Excel file");
  const target = new Map<string, string>();
  for (const m of (z.read("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1];
    const to = /\bTarget="([^"]*)"/.exec(m[0])?.[1];
    if (id && to) target.set(id, to.replace(/^\/?(xl\/)?/, ""));
  }
  const shared: string[] = [];
  const strings = z.read("xl/sharedStrings.xml");
  if (strings) for (const si of strings.matchAll(/<si\b[\s\S]*?<\/si>/g)) shared.push(textsOf(si[0]));

  const out: string[] = [];
  let sheets = 0;
  for (const sheet of book.matchAll(/<sheet\b[^>]*>/g)) {
    if (++sheets > MAX_SHEETS) {
      out.push(`(only the first ${MAX_SHEETS} sheets are shown)`);
      break;
    }
    const name = decodeEntities(/\bname="([^"]*)"/.exec(sheet[0])?.[1] ?? "Sheet");
    const rid = /\br:id="([^"]*)"/.exec(sheet[0])?.[1];
    const path = rid ? target.get(rid) : undefined;
    const xml = path ? z.read(`xl/${path}`) : null;
    if (!xml) continue;
    const rows: string[][] = [];
    let cut = false;
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= MAX_SHEET_ROWS) {
        cut = true;
        break;
      }
      const cells: string[] = [];
      for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? "";
        const body = c[2] ?? "";
        const letters = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        const value = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? textsOf(body) : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : decodeEntities(v ?? "");
        const col = letters ? columnOf(letters) : cells.length;
        if (col < MAX_SHEET_COLS) cells[col] = value;
      }
      rows.push(Array.from(cells, (x) => x ?? ""));
    }
    out.push(`## Sheet: ${name}\n${rows.map((r) => r.join("\t").replace(/\t+$/, "")).join("\n")}${cut ? `\n(only the first ${MAX_SHEET_ROWS} rows are shown)` : ""}`);
  }
  return out.join("\n\n");
}

function pptxText(z: Zip): string {
  const number = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
  const slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => number(a) - number(b));
  if (slides.length === 0) throw new Error("not a PowerPoint file");
  const shown = slides.slice(0, MAX_SLIDES).map((name, i) => {
    const xml = (z.read(name) ?? "").replace(/<\/a:p>/g, "\n").replace(/<[^>]+>/g, "");
    return `## Slide ${i + 1}\n${tidy(decodeEntities(xml))}`;
  });
  return shown.join("\n\n") + (slides.length > MAX_SLIDES ? `\n\n(only the first ${MAX_SLIDES} slides are shown)` : "");
}

/**
 * The text of a PDF, page by page. The reader only extracts text: this version of the PDF library has no code evaluation for fonts any more, and it is told not to
 * load fonts from the PC, and it reads at most MAX_PDF_PAGES pages and gives up after PDF_TIMEOUT_MS.
 */
async function pdfText(bytes: Buffer): Promise<string> {
  const { getDocumentProxy } = await import("unpdf");
  const work = (async () => {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, useSystemFonts: false });
    try {
      const pages: string[] = [];
      const last = Math.min(pdf.numPages, MAX_PDF_PAGES);
      for (let n = 1; n <= last; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        const line = content.items.map((it) => ("str" in it ? `${it.str}${it.hasEOL ? "\n" : ""}` : "")).join("");
        pages.push(`--- page ${n} ---\n${line.trim()}`);
      }
      if (pdf.numPages > last) pages.push(`(only the first ${last} of ${pdf.numPages} pages are shown)`);
      return pages.join("\n\n");
    } finally {
      void (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()?.catch(() => {});
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the PDF took too long to read")), PDF_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}); // if it lost the race, its late failure is not an unhandled one
  }
}

const cap = (text: string): string => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n(the rest of the file is not shown: it is longer than ${MAX_TEXT_CHARS} characters)` : text);

/** Turns an attached file into what the assistant can read. Never runs anything in the file, never throws: a file it cannot read comes back with the reason. */
export async function extractFile(name: string, bytes: Buffer): Promise<Extracted> {
  const ext = extOf(name);
  try {
    if (IMAGES[ext]) {
      if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `The picture is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB, too big to look at.` };
      if (!looksLike(IMAGES[ext]!, bytes)) return { ok: false, error: `This file is not a real .${ext} picture.` };
      return { ok: true, kind: "image", mime: IMAGES[ext]!, data: bytes.toString("base64") };
    }
    let text: string;
    if (ext === "pdf") {
      text = await pdfText(bytes);
      if (text.replace(/--- page \d+ ---/g, "").trim().length < 10) return { ok: false, error: "This PDF has no text to read (it may be a scan or only pictures)." };
    } else if (ext === "docx" || ext === "xlsx" || ext === "pptx") {
      const z = openZip(bytes);
      text = ext === "docx" ? docxText(z) : ext === "xlsx" ? xlsxText(z) : pptxText(z);
    } else if (ext === "doc" || ext === "xls" || ext === "ppt") {
      return { ok: false, error: `This is an old ${ext.toUpperCase()} file. Save it as .${ext}x (or as PDF) and attach that.` };
    } else if (ext === "html" || ext === "htm") {
      text = htmlText(decodeText(bytes));
    } else if (TEXT_EXT.has(ext) || !bytes.subarray(0, 8000).includes(0)) {
      if (bytes.subarray(0, 8000).includes(0) && !(bytes[0] === 0xff && bytes[1] === 0xfe)) return { ok: false, error: "This file is not text." };
      text = decodeText(bytes);
    } else {
      return { ok: false, error: `I cannot read .${ext || "this kind of"} files.` };
    }
    if (text.trim() === "") return { ok: false, error: "There is no text in this file." };
    return { ok: true, kind: "text", text: cap(text) };
  } catch (e) {
    const why = (e as Error).message;
    return { ok: false, error: /password|encrypt/i.test(why) ? "This file is protected with a password." : /took too long|too much|too large/i.test(why) ? `This file is too large or too complex to read (${why.replace(/^the /, "")}).` : "I could not read this file (it may be damaged)." };
  }
}
