import type { Deck, DeckItem } from "@friend/protocol";
import PptxGenJS from "pptxgenjs";

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** A table as rows of text: the first row is the heading. Rows may be lists or objects keyed by column. */
function rowsOf(c: Record<string, unknown>): string[][] {
  const cols = arr(c.columns).map((x, i) =>
    x && typeof x === "object" ? { key: String((x as { key?: unknown }).key ?? `c${i}`), label: cell((x as { label?: unknown }).label ?? (x as { key?: unknown }).key) } : { key: `c${i}`, label: cell(x) },
  );
  return [cols.map((x) => x.label), ...arr(c.rows).map((r) => cols.map((x, i) => cell(Array.isArray(r) ? r[i] : (r as Record<string, unknown> | null)?.[x.key])))];
}

/** A line for an item that is not a table: what it says in words, so the slide stays readable in PowerPoint. */
function line(it: DeckItem): { text: string; bold?: boolean; bullet: boolean } {
  const c = it.content;
  if (it.kind === "text") return { text: cell(c.text), bold: c.style === "heading", bullet: c.style !== "heading" && c.style !== "quote" };
  if (it.kind === "chart" || it.kind === "JBarChart" || it.kind === "JLineChart") {
    const labels = arr(c.labels).map(cell);
    const s = arr(c.series).map((x) => `${cell((x as { name?: unknown }).name)}: ${arr((x as { values?: unknown }).values).map(cell).join(", ")}`);
    return { text: `${cell(c.title) || "Chart"} (${labels.join(", ")}) ${s.join("; ")}`.trim(), bullet: true };
  }
  if (it.kind === "list" || it.kind === "checklist") return { text: `${cell(c.title)} ${arr(c.items).map((i) => cell(typeof i === "object" && i ? (i as { text?: unknown }).text : i)).join("; ")}`.trim(), bullet: true };
  if (it.kind === "card" || it.kind === "JCard") return { text: `${cell(c.title)} ${cell(c.text)}`.trim(), bullet: true };
  if (it.kind === "code") return { text: cell(c.code), bullet: false };
  return { text: cell(c.title ?? c.label ?? it.kind), bullet: true };
}

/** A .pptx the owner can edit in PowerPoint: titles, points, tables, and the notes and spoken lines in each slide's notes. Animations are not carried over (the web page export keeps them). */
export async function deckToPptx(deck: Deck, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const p = new PptxGenJS();
  p.title = deck.title;
  p.layout = "LAYOUT_16x9";
  for (const s of deck.slides) {
    const slide = p.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.3, w: 9, h: 0.9, fontSize: 30, bold: true, color: "0A7AA5" });
    const lines: PptxGenJS.TextProps[] = [];
    let y = 1.4;
    for (const it of s.items) {
      if (it.kind === "table" || it.kind === "JTable") {
        const rows = rowsOf(it.content);
        if (lines.length) {
          const h = Math.min(2.2, 0.45 * lines.length + 0.2);
          slide.addText(lines.splice(0), { x: 0.7, y, w: 8.6, h, fontSize: 20, valign: "top" });
          y += h;
        }
        slide.addTable(
          rows.map((r, ri) => r.map((t) => ({ text: t, options: { bold: ri === 0, fontSize: 14 } }))),
          { x: 0.7, y, w: 8.6, border: { type: "solid", color: "999999", pt: 0.5 } },
        );
        y += 0.4 * rows.length + 0.2;
      } else {
        const l = line(it);
        lines.push({ text: l.text, options: { bullet: l.bullet, bold: l.bold === true, breakLine: true } });
      }
    }
    if (lines.length) slide.addText(lines, { x: 0.7, y, w: 8.6, h: Math.max(1, 5.2 - y), fontSize: 20, valign: "top" });
    const spoken = s.items.map((it) => it.say).filter(Boolean);
    slide.addNotes([s.notes, spoken.length ? `Spoken:\n${spoken.join("\n")}` : ""].filter(Boolean).join("\n\n"));
  }
  const out = await p.write({ outputType: "nodebuffer", compression: opts.compress !== false });
  return Buffer.from(out as Uint8Array);
}
