/** Who a line of the feed belongs to. Everyone gets a colour and initials of their own, the same everywhere on the screen. */
export interface Who {
  id: string;
  name: string;
  /** office: a Claude Code worker; crew: a worker on Friend's own engine; you; friend: the assistant. */
  kind: "office" | "crew" | "you" | "friend";
  role?: string;
}

/** One line of the feed with the person it belongs to. */
export interface Act {
  who: Who;
  /** 0 when the time is not known (the conversation has no times). */
  at: number;
  /** tool, result, text, done, error, approval, task… (what kind of line it is). */
  kind: string;
  text: string;
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** A hue from the person's id: the same person is always the same colour. */
export const hueOf = (id: string): number => (hash(id) * 137) % 360;

export const colourOf = (who: Who, l = 62): string => (who.kind === "you" ? "hsl(200 20% 82%)" : who.kind === "friend" ? `hsl(190 90% ${l}%)` : `hsl(${hueOf(`${who.kind}:${who.id}`)} 78% ${l}%)`);

export const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts.length > 1 ? parts[0]![0]! + parts[1]![0]! : name.trim().slice(0, 2)) || "?").toUpperCase();
};

export const kindLabel = (k: Who["kind"]): string => (k === "office" ? "OFFICE" : k === "crew" ? "CREW" : k === "you" ? "YOU" : "FRIEND");

/** A small mark for what a line is. */
export const markOf = (kind: string): string => ({ tool: "⚙", result: "✓", done: "✓", error: "⚠", approval: "?", task: "▸", text: "" })[kind] ?? "";
