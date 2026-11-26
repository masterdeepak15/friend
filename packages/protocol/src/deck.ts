import { z } from "zod";
import { OBJECT_TYPES } from "./stage";

/** How a slide is laid out. The player chooses the places itself; the layout says how many items look right. */
export const DECK_LAYOUTS = ["title", "bullets", "visual", "two-column", "quote", "end"] as const;
export type DeckLayout = (typeof DECK_LAYOUTS)[number];
/** How many items fit a layout and still look good. A slide with more is split by the assistant. */
export const LAYOUT_CAPACITY: Record<DeckLayout, number> = { title: 2, bullets: 5, visual: 1, "two-column": 8, quote: 2, end: 2 };
export const DECK_ANIMATIONS = ["fade", "slide-left", "slide-up", "grow", "type", "draw", "none"] as const;
export type DeckAnimation = (typeof DECK_ANIMATIONS)[number];
export const DECK_CONTROLS = ["next", "back", "pause", "resume", "repeat", "goto", "stop"] as const;
export type DeckControl = (typeof DECK_CONTROLS)[number];

export const DECK_LIMITS = { slides: 40, say: 400, title: 120, items: 8 } as const;

/** `text` is a heading, a bullet or a quote ({ text, style? }); any other kind is a stage object type with its props as content. */
export const deckKinds = (): string[] => ["text", ...(OBJECT_TYPES as readonly string[])];

export const DeckItem = z.object({
  id: z.string().min(1).max(40),
  kind: z.string().min(1).max(40),
  content: z.record(z.string(), z.unknown()),
  /** What the assistant says while this item appears. */
  say: z.string().max(DECK_LIMITS.say),
  animation: z.enum(DECK_ANIMATIONS).optional(),
  /** Seconds to wait after speaking. */
  hold: z.number().min(0).max(60).optional(),
});
export type DeckItem = z.infer<typeof DeckItem>;

export const DeckSlide = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(DECK_LIMITS.title),
  layout: z.enum(DECK_LAYOUTS),
  /** For the owner and for export; not spoken. */
  notes: z.string().max(2000).optional(),
  items: z.array(DeckItem).max(DECK_LIMITS.items),
});
export type DeckSlide = z.infer<typeof DeckSlide>;

export const Deck = z.object({
  id: z.string().min(1).max(40),
  title: z.string().min(1).max(DECK_LIMITS.title),
  topic: z.string().max(200).optional(),
  slides: z.array(DeckSlide).max(DECK_LIMITS.slides),
  createdAt: z.number(),
});
export type Deck = z.infer<typeof Deck>;

/** What the screens draw: one slide, how many of its items are shown, and whether the player is going. */
export const DeckView = z
  .object({
    deckId: z.string(),
    title: z.string(),
    index: z.number().int().min(0),
    total: z.number().int().min(1),
    slide: DeckSlide,
    shown: z.number().int().min(0),
    state: z.enum(["playing", "paused", "ended"]),
  })
  .refine((v) => v.shown <= v.slide.items.length, { message: "shown is more than the slide has" });
export type DeckView = z.infer<typeof DeckView>;

/** A sentence for the assistant saying what is wrong with a deck, or null when it can be saved and presented. */
export function deckProblem(deck: unknown): string | null {
  const d = Deck.safeParse(deck);
  if (!d.success) {
    const i = d.error.issues[0]!;
    if (i.code === "too_big" && i.path[0] === "slides") return `A deck can have at most ${DECK_LIMITS.slides} slides.`;
    return `The deck is not valid at ${i.path.join(".") || "the top"}: ${i.message}`;
  }
  const kinds = deckKinds();
  const seen = new Set<string>();
  for (const [n, s] of d.data.slides.entries()) {
    const at = `Slide ${n + 1} ("${s.title}")`;
    if (seen.has(s.id)) return `${at} has the same id as another slide.`;
    seen.add(s.id);
    const cap = LAYOUT_CAPACITY[s.layout];
    if (s.items.length > cap) return `${at} has ${s.items.length} items but a ${s.layout} slide fits ${cap} and still looks good: split it into two slides.`;
    const ids = new Set<string>();
    for (const it of s.items) {
      if (ids.has(it.id)) return `${at} has two items with the id ${it.id}.`;
      ids.add(it.id);
      if (!kinds.includes(it.kind)) return `${at}: item ${it.id} has an unknown kind "${it.kind}".`;
      if (it.kind === "text" && typeof it.content.text !== "string") return `${at}: a text item needs content.text.`;
    }
  }
  return null;
}

/** What the assistant sends: ids are optional, the server gives them. */
export const DeckItemInput = DeckItem.extend({ id: z.string().min(1).max(40).optional() });
export const DeckSlideInput = DeckSlide.extend({ id: z.string().min(1).max(40).optional(), items: z.array(DeckItemInput).max(DECK_LIMITS.items) });
export type DeckSlideInput = z.infer<typeof DeckSlideInput>;

let counter = 0;
const fresh = (p: string): string => `${p}${Date.now().toString(36).slice(-4)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Slides with an id on every slide and item. Ids that were given stay. */
export function withIds(slides: readonly DeckSlideInput[]): DeckSlide[] {
  return slides.map((s) => ({ ...s, id: s.id ?? fresh("s"), items: s.items.map((i) => ({ ...i, id: i.id ?? fresh("i") })) }));
}
