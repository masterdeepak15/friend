import { withIds, type Deck, type DeckItem, type DeckSlideInput, type Trust } from "@friend/protocol";
import type { Presenter } from "./presenter";
import type { DeckStore } from "./store";

export interface DeckToolDeps {
  store: DeckStore;
  presenter: Presenter;
  trust: Trust;
  /** Writes the deck as a file in the owner's files area and returns where it is. */
  exportDeck(id: string, format: "pptx" | "html"): Promise<string>;
}
export type DeckToolResult = { text: string; isError: boolean };

const ok = (text: string): DeckToolResult => ({ text, isError: false });
const fail = (text: string): DeckToolResult => ({ text: `Error: ${text}`, isError: true });
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A deck as text for the assistant to read: slides, items and what is said. */
export function outline(deck: Deck): string {
  const lines = [`Deck ${deck.id} "${deck.title}" (${deck.slides.length} slides)`];
  deck.slides.forEach((s, n) => {
    lines.push(`${n + 1}. ${s.title} [${s.layout}]`);
    s.items.forEach((it, k) => {
      const what = it.kind === "text" ? clip(String(it.content.text ?? ""), 70) : `(${it.kind})`;
      lines.push(`   ${k + 1}) ${what}${it.animation ? ` {${it.animation}}` : ""} — say: "${clip(it.say, 80)}"`);
    });
  });
  return lines.join("\n");
}

/** Throws a sentence for the assistant when a slide or item number is not there. */
function slideAt(d: Deck, n: number | undefined): number {
  if (n === undefined || n < 1 || n > d.slides.length) throw new Error(`There is no slide ${n ?? "(none given)"}: the deck has ${d.slides.length}.`);
  return n - 1;
}
function itemAt(d: Deck, si: number, n: number | undefined): number {
  const count = d.slides[si]!.items.length;
  if (n === undefined || n < 1 || n > count) throw new Error(`Slide ${si + 1} has no item ${n ?? "(none given)"}: it has ${count}.`);
  return n - 1;
}
const position = (at: number | undefined, length: number): number => (at === undefined ? length : Math.min(Math.max(at - 1, 0), length));

function edit(d: Deck, a: Record<string, unknown>): Deck {
  const op = a.op as string;
  const slideData = a.slideData as DeckSlideInput | undefined;
  const itemData = a.itemData as (Omit<DeckItem, "id"> & { id?: string }) | undefined;
  const slides = d.slides;
  switch (op) {
    case "add-slide": {
      if (!slideData) throw new Error("add-slide needs slideData.");
      slides.splice(position(a.at as number | undefined, slides.length), 0, withIds([slideData])[0]!);
      return d;
    }
    case "replace-slide": {
      const i = slideAt(d, a.slide as number | undefined);
      if (!slideData) throw new Error("replace-slide needs slideData.");
      slides[i] = { ...withIds([slideData])[0]!, id: slides[i]!.id };
      return d;
    }
    case "move-slide": {
      const i = slideAt(d, a.slide as number | undefined);
      const [moved] = slides.splice(i, 1);
      slides.splice(position(a.to as number | undefined, slides.length), 0, moved!);
      return d;
    }
    case "delete-slide":
      slides.splice(slideAt(d, a.slide as number | undefined), 1);
      return d;
    case "add-item": {
      const i = slideAt(d, a.slide as number | undefined);
      if (!itemData) throw new Error("add-item needs itemData.");
      const items = slides[i]!.items;
      items.splice(position(a.at as number | undefined, items.length), 0, withIds([{ title: "", layout: "bullets", items: [itemData] }])[0]!.items[0]!);
      return d;
    }
    case "replace-item": {
      const i = slideAt(d, a.slide as number | undefined);
      const k = itemAt(d, i, a.item as number | undefined);
      if (!itemData) throw new Error("replace-item needs itemData.");
      slides[i]!.items[k] = { ...withIds([{ title: "", layout: "bullets", items: [itemData] }])[0]!.items[0]!, id: slides[i]!.items[k]!.id };
      return d;
    }
    case "delete-item": {
      const i = slideAt(d, a.slide as number | undefined);
      slides[i]!.items.splice(itemAt(d, i, a.item as number | undefined), 1);
      return d;
    }
  }
  throw new Error(`Unknown edit: ${op}`);
}

/** The deck.* tools. Only the owner makes, changes and presents decks. */
export async function runDeckTool(name: string, args: unknown, d: DeckToolDeps): Promise<DeckToolResult> {
  if (d.trust !== "owner") return fail("Only the owner can use presentations.");
  const a = (args ?? {}) as Record<string, unknown>;
  const id = typeof a.id === "string" ? a.id : "";
  switch (name) {
    case "deck.create": {
      const made = d.store.create({ title: String(a.title), ...(typeof a.topic === "string" ? { topic: a.topic } : {}), slides: a.slides as DeckSlideInput[] });
      if ("error" in made) return fail(made.error);
      return ok(`Saved. ${outline(made)}\nPresent it with deck.present {id: "${made.id}"} when the owner wants it.`);
    }
    case "deck.list": {
      const all = d.store.list();
      return ok(all.length ? all.map((x) => `${x.id} "${x.title}" (${x.slides} slides)`).join("\n") : "There are no presentations yet.");
    }
    case "deck.show": {
      const deck = d.store.get(id);
      return deck ? ok(outline(deck)) : fail("No such presentation.");
    }
    case "deck.edit": {
      let error = "";
      const next = d.store.update(id, (deck) => {
        try {
          return edit(deck, a);
        } catch (e) {
          error = (e as Error).message;
          return deck;
        }
      });
      if (error) return fail(error);
      if ("error" in next) return fail(next.error);
      d.presenter.deckChanged(id, next);
      return ok(`Changed. ${outline(next)}`);
    }
    case "deck.present": {
      const deck = d.store.get(id);
      if (!deck) return fail("No such presentation.");
      const said = d.presenter.start(deck, { ...(typeof a.slide === "number" ? { slide: a.slide } : {}), ...(typeof a.item === "number" ? { item: a.item } : {}) });
      return /^Presenting/.test(said) ? ok(`${said} The owner may talk at any time: it pauses, you answer, then call deck.control resume.`) : fail(said);
    }
    case "deck.control": {
      const said = d.presenter.control(a.action as never, typeof a.slide === "number" ? a.slide : undefined);
      return ok(said);
    }
    case "deck.export": {
      if (!d.store.get(id)) return fail("No such presentation.");
      try {
        return ok(`Saved as ${await d.exportDeck(id, a.format as "pptx" | "html")}`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    case "deck.delete": {
      if (!d.store.remove(id)) return fail("No such presentation.");
      const stopped = d.presenter.deckChanged(id, null);
      return ok(stopped ?? "Deleted.");
    }
  }
  return fail(`Unknown tool: ${name}`);
}
