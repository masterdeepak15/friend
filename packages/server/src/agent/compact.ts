import type { Msg, Provider } from "../provider/types";

const SYSTEM =
  "You write short notes for an assistant named Friend, so that it can carry on a long conversation after its memory of it is cleared. " +
  "Write at most 250 words of plain text, with no preamble. Keep what the owner is working on, decisions made, preferences, names, " +
  "things promised and tasks still open. Leave out greetings, small talk and anything already finished. Do not invent anything.";

const MAX_LINE = 1500;
const MAX_TEXT = 30_000;
const MAX_SUMMARY = 4000;

/** The words that were said, in order. Tool calls and their results are left out. */
export function conversationText(history: Msg[]): string {
  const lines: string[] = [];
  for (const m of history) {
    if (m.role === "tool") continue;
    const t = m.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join(" ")
      .trim();
    if (t) lines.push(`${m.role === "user" ? "Owner" : "Friend"}: ${t.slice(0, MAX_LINE)}`);
  }
  return lines.join("\n").slice(-MAX_TEXT);
}

/**
 * Asks the model, in a throwaway conversation of its own (no tools, nothing of the owner's), for the notes that would let the
 * conversation carry on. Resolves null when there is nothing to summarise or the model could not do it.
 */
export async function summarize(provider: Provider, history: Msg[], earlier: string | null, signal: AbortSignal): Promise<string | null> {
  const words = conversationText(history);
  if (!words) return null;
  const ask = `${earlier ? `Notes from before:\n${earlier}\n\n` : ""}Conversation:\n${words}\n\nWrite the notes now.`;
  let out = "";
  try {
    for await (const ev of provider.stream({ system: SYSTEM, session: "guest", messages: [{ role: "user", content: [{ type: "text", text: ask }] }], tools: [], signal })) {
      if (ev.type === "text_delta") out += ev.text;
      else if (ev.type === "error") return null;
    }
  } catch {
    return null;
  }
  out = out.trim().slice(0, MAX_SUMMARY);
  return out || null;
}
