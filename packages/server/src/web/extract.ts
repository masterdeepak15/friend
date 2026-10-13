/** What a web page says, without the page: its title and its words. Nothing in the page is run or followed. */
export interface Extracted {
  title: string;
  text: string;
  /** How many characters were left out to stay under the limit. */
  cut: number;
}

const BREAK = "\u0002"; // a new line in the page's layout (the text itself may contain real new lines that mean nothing)
const CELL = "\u0001"; // the end of a table cell

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", euro: "€", pound: "£", yen: "¥", times: "×", deg: "°", middot: "·", bull: "•", laquo: "«", raquo: "»",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return all;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? all;
  });
}

const oneLine = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** Pairs like `<script ...> ... </script>` removed whole; one that is never closed is removed to the end of the page. */
function dropBlocks(html: string, tags: string): string {
  return html.replace(new RegExp(`<(${tags})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), " ").replace(new RegExp(`<(?:${tags})\\b[\\s\\S]*$`, "i"), " ");
}

export function extractText(input: string, maxChars = 12_000): Extracted {
  let html = String(input ?? "");
  const looksLikeHtml = /<[a-zA-Z!/]/.test(html);

  let text: string;
  let title = "";
  if (!looksLikeHtml) {
    text = html
      .split(/\r?\n/)
      .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  } else {
    const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    if (t) title = oneLine(t[1]!.replace(/<[^>]*>/g, ""));

    html = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!--[\s\S]*$/, " ");
    html = dropBlocks(html, "script|style|noscript|template|svg|iframe|object|canvas");
    html = html.replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ").replace(/<title\b[\s\S]*?<\/title\s*>/gi, " ");
    html = dropBlocks(html, "nav|header|footer|form|aside|select|button");
    html = html.replace(/<(div|span|section|p|ul|table|li)\b[^>]*(?:\shidden(?:[\s=>]|$)|display\s*:\s*none|aria-hidden\s*=\s*["']?true)[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

    // the main part of the page, when it says which part that is
    const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html);
    if (main) html = main[1]!;
    else {
      const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1]!);
      if (articles.length) html = articles.join(`<br>`);
    }

    html = html
      .replace(/<\/t[dh]\s*>/gi, CELL)
      .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|section|article|main|tr|table|thead|tbody|blockquote|pre|dd|dt|dl|hr|figure|figcaption|address|details|summary)\b[^>]*>/gi, BREAK)
      .replace(/<[^>]*>/g, " ")
      .replace(/<[^>]*$/, " ");

    text = decode(html)
      .replace(/\s+/g, " ") // the page's own white space becomes a space; the layout breaks (not white space) survive
      .split(BREAK)
      .map((line) =>
        line
          .split(CELL)
          .map((c) => c.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" | "),
      )
      .filter(Boolean)
      .join("\n");
  }

  const cut = Math.max(0, text.length - maxChars);
  return { title, text: cut ? text.slice(0, maxChars) : text, cut };
}
