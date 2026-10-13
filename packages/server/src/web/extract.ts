/** What a web page says, without the page: its title and its words. Nothing in the page is run or followed. */
export interface Extracted {
  title: string;
  text: string;
  /** How many characters were left out to stay under the limit. */
  cut: number;
}

const BREAK = "\u0002"; // a new line in the page's layout (the text itself may contain real new lines that mean nothing)
const CELL = "\u0001"; // the end of a table cell
const MAIN_OPEN = "\u0003";
const MAIN_CLOSE = "\u0004";
const ART_OPEN = "\u0005";
const ART_CLOSE = "\u0006";
const MARKS = /[\u0003-\u0006]/g;

/** Only the start of a page is read: the words that matter come first, and the work stays small however big the page is. */
const MAX_INPUT = 500_000;
const TITLE_MAX = 200;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", euro: "€", pound: "£", yen: "¥", times: "×", deg: "°", middot: "·", bull: "•", laquo: "«", raquo: "»",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? all;
  });
}

const oneLine = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

/** Elements whose whole content is left out. `script` and `style` hold raw text; the others may nest. */
const RAW = new Set(["script", "style"]);
const DROP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "canvas", "nav", "header", "footer", "form", "aside", "select", "button"]);
/** Elements that are left out when they say they are hidden. */
const HIDEABLE = new Set(["div", "span", "section", "p", "ul", "table", "li"]);
const HIDDEN = /(?:^|\s)hidden(?:[\s=]|$)|display\s*:\s*none|aria-hidden\s*=\s*["']?true/i;
const BLOCKS = new Set(["p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "section", "tr", "table", "thead", "tbody", "blockquote", "pre", "dd", "dt", "dl", "hr", "figure", "figcaption", "address", "details", "summary"]);
const TAG = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;

/**
 * One pass over the page, each character looked at a bounded number of times, so no page (unclosed comments, tags that never end,
 * thousands of hidden blocks) can keep Friend busy: the work is proportional to the size, never to its square.
 */
function scan(html: string): { title: string; out: string } {
  const n = html.length;
  const out: string[] = [];
  let title = "";
  let i = 0;
  let gtAt = -2; // where the next ">" is; looked for again only after passing it
  let skip: { name: string; depth: number } | null = null;

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      if (!skip) out.push(html.slice(i));
      break;
    }
    if (lt > i && !skip) out.push(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break; // a comment that never ends swallows the rest of the page
      i = end + 3;
      continue;
    }
    if (gtAt !== -1 && gtAt < lt + 1) gtAt = html.indexOf(">", lt + 1);
    if (gtAt === -1) break; // no tag ends after this: the rest is not a page
    const inner = html.slice(lt + 1, gtAt);
    const m = TAG.exec(inner);
    if (!m) {
      if (inner[0] === "!" || inner[0] === "?") i = gtAt + 1; // <!doctype ...>, <?xml ...?>
      else {
        if (!skip) out.push("<"); // a lone "<" in the text
        i = lt + 1;
      }
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const selfClosing = inner.endsWith("/");
    i = gtAt + 1;

    if (skip) {
      if (name === skip.name) {
        if (closing) {
          if (--skip.depth <= 0) skip = null;
        } else if (!selfClosing) skip.depth++;
      }
      continue;
    }

    if (name === "title" && !closing) {
      const end = new RegExp("</title\\b", "gi");
      end.lastIndex = i;
      const found = end.exec(html);
      const stop = found ? found.index : n;
      if (!title) title = oneLine(html.slice(i, Math.min(stop, i + 4 * TITLE_MAX)).replace(/<[^>]{0,200}>/g, "")).slice(0, TITLE_MAX);
      i = stop;
      continue;
    }

    if (!closing && RAW.has(name)) {
      const end = new RegExp(`</${name}\\b`, "gi");
      end.lastIndex = i;
      const found = end.exec(html);
      if (!found) break; // never closed: the rest of the page is script
      i = found.index; // the closing tag itself is read normally next
      continue;
    }

    if (!closing && !selfClosing && (DROP.has(name) || (HIDEABLE.has(name) && HIDDEN.test(inner.slice(m[0].length, m[0].length + 2000))))) {
      skip = { name, depth: 1 };
      continue;
    }

    if (name === "main") out.push(BREAK, closing ? MAIN_CLOSE : MAIN_OPEN);
    else if (name === "article") out.push(BREAK, closing ? ART_CLOSE : ART_OPEN);
    else if (closing && (name === "td" || name === "th")) out.push(CELL);
    else if (BLOCKS.has(name)) out.push(BREAK);
    else out.push(" ");
  }
  return { title, out: out.join("") };
}

/** The first `open`..`close` part, or to the end of the page when it never closes. */
function firstRegion(s: string, open: string, close: string): string | null {
  const a = s.indexOf(open);
  if (a < 0) return null;
  const b = s.indexOf(close, a + 1);
  return s.slice(a + 1, b < 0 ? s.length : b);
}

function allRegions(s: string, open: string, close: string): string | null {
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    const a = s.indexOf(open, at);
    if (a < 0) break;
    const b = s.indexOf(close, a + 1);
    parts.push(s.slice(a + 1, b < 0 ? s.length : b));
    if (b < 0) break;
    at = b + 1;
  }
  return parts.length ? parts.join(BREAK) : null;
}

export function extractText(input: string, maxChars = 12_000): Extracted {
  const html = String(input ?? "").slice(0, MAX_INPUT);

  let text: string;
  let title = "";
  if (!/<[a-zA-Z!/]/.test(html)) {
    text = html
      .split(/\r?\n/)
      .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  } else {
    const scanned = scan(html);
    title = scanned.title;
    // the main part of the page, when it says which part that is
    const chosen = firstRegion(scanned.out, MAIN_OPEN, MAIN_CLOSE) ?? allRegions(scanned.out, ART_OPEN, ART_CLOSE) ?? scanned.out;
    text = decodeEntities(chosen.replace(MARKS, ""))
      .replace(/\s+/g, " ") // the page's own white space becomes a space; the layout breaks (not white space) survive
      .split(BREAK)
      .map((line) =>
        line
          .split(CELL)
          .map((c) => c.trim())
          .filter(Boolean)
          .join(" | "),
      )
      .filter(Boolean)
      .join("\n");
  }

  const cut = Math.max(0, text.length - maxChars);
  return { title, text: cut ? text.slice(0, maxChars) : text, cut };
}
