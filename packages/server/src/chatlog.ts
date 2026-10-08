import type { Db } from "./db";

export interface ChatLine {
  role: "user" | "assistant";
  text: string;
}

/** The owner's side of the conversation as plain text: what was said and what was answered, without tool traffic. */
export function chatLines(db: Db, limit = 80): ChatLine[] {
  const rows = db.prepare("select role, content_json from messages order by id desc limit ?").all(limit * 4) as { role: string; content_json: string }[];
  const out: ChatLine[] = [];
  for (const r of rows.reverse()) {
    if (r.role !== "user" && r.role !== "assistant") continue;
    let blocks: { type?: string; text?: unknown }[];
    try {
      blocks = JSON.parse(r.content_json) as { type?: string; text?: unknown }[];
    } catch {
      continue;
    }
    const text = blocks
      .flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : []))
      .join("")
      .trim();
    if (!text) continue;
    const last = out.at(-1);
    if (r.role === "assistant" && last?.role === "assistant") last.text += `\n\n${text}`; // one answer that was written in steps
    else out.push({ role: r.role, text });
  }
  return out.slice(-limit);
}
