import { randomBytes } from "node:crypto";
import { Deck, deckProblem, withIds, type DeckSlideInput } from "@friend/protocol";
import type { Db } from "../db";

export interface DeckSummary {
  id: string;
  title: string;
  slides: number;
  createdAt: number;
}

/** The owner's presentations, kept in the database. */
export class DeckStore {
  constructor(private readonly db: Db) {}

  create(input: { title: string; topic?: string; slides: readonly DeckSlideInput[] }): Deck | { error: string } {
    const deck: Deck = { id: `d_${randomBytes(4).toString("hex")}`, title: input.title, ...(input.topic ? { topic: input.topic } : {}), slides: withIds(input.slides), createdAt: Date.now() };
    const bad = deckProblem(deck);
    if (bad) return { error: bad };
    this.db.prepare("insert into decks (id, deck_json, created_at) values (?, ?, ?)").run(deck.id, JSON.stringify(deck), deck.createdAt);
    return deck;
  }

  get(id: string): Deck | null {
    const row = this.db.prepare("select deck_json j from decks where id = ?").get(id) as { j: string } | undefined;
    return row ? this.parse(row.j) : null;
  }

  list(): DeckSummary[] {
    const rows = this.db.prepare("select deck_json j from decks order by created_at desc, rowid desc").all() as { j: string }[];
    const out: DeckSummary[] = [];
    for (const r of rows) {
      const d = this.parse(r.j);
      if (d) out.push({ id: d.id, title: d.title, slides: d.slides.length, createdAt: d.createdAt });
    }
    return out;
  }

  /** Changes a deck. The result is checked like a new deck; when it is refused the saved deck stays as it was. */
  update(id: string, change: (d: Deck) => Deck): Deck | { error: string } {
    const old = this.get(id);
    if (!old) return { error: "No such presentation." };
    const next = change(structuredClone(old));
    const bad = deckProblem(next);
    if (bad) return { error: bad };
    this.db.prepare("update decks set deck_json = ? where id = ?").run(JSON.stringify(next), id);
    return next;
  }

  remove(id: string): boolean {
    return this.db.prepare("delete from decks where id = ?").run(id).changes > 0;
  }

  private parse(json: string): Deck | null {
    try {
      const r = Deck.safeParse(JSON.parse(json));
      return r.success ? r.data : null; // a damaged row is skipped, not fatal
    } catch {
      return null;
    }
  }
}
