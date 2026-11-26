import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { DeckStore } from "./store";

const slide = (title: string, n = 1) => ({ title, layout: "bullets" as const, items: Array.from({ length: n }, (_, i) => ({ kind: "text", content: { text: `p${i}` }, say: "s" })) });
const db = () => openDb(mkdtempSync(join(tmpdir(), "friend-deck-")));

describe("saved presentations", () => {
  it("keep their slides and ids, and are still there for a new store on the same database", () => {
    const d = db();
    const made = new DeckStore(d).create({ title: "Hacking", topic: "security", slides: [slide("Intro", 2), slide("Tools")] });
    if ("error" in made) throw new Error(made.error);
    expect(made.id).toMatch(/^d_[0-9a-f]{8}$/);
    expect(made.slides[0]!.id).toBeTruthy();
    const again = new DeckStore(d).get(made.id)!;
    expect(again.title).toBe("Hacking");
    expect(again.slides.map((s) => s.title)).toEqual(["Intro", "Tools"]);
  });

  it("refuses a deck that breaks the limits, with the sentence", () => {
    const r = new DeckStore(db()).create({ title: "Big", slides: [slide("Too many", 6)] });
    expect("error" in r && r.error).toMatch(/split/);
  });

  it("an edit is checked again: a refused edit leaves the deck as it was", () => {
    const s = new DeckStore(db());
    const made = s.create({ title: "T", slides: [slide("A", 5)] }) as { id: string };
    const r = s.update(made.id, (d) => ({ ...d, slides: [{ ...d.slides[0]!, items: [...d.slides[0]!.items, d.slides[0]!.items[0]!].map((i, n) => ({ ...i, id: `x${n}` })) }] }));
    expect("error" in r).toBe(true);
    expect(s.get(made.id)!.slides[0]!.items).toHaveLength(5);
  });

  it("lists the newest first with the number of slides, and removes", () => {
    const s = new DeckStore(db());
    const a = s.create({ title: "A", slides: [slide("1")] }) as { id: string };
    const b = s.create({ title: "B", slides: [slide("1"), slide("2")] }) as { id: string };
    expect(s.list().map((d) => [d.title, d.slides])).toEqual([["B", 2], ["A", 1]]);
    expect(s.remove(a.id)).toBe(true);
    expect(s.remove(a.id)).toBe(false);
    expect(s.list().map((d) => d.id)).toEqual([b.id]);
  });

  it("skips a damaged row", () => {
    const d = db();
    const s = new DeckStore(d);
    s.create({ title: "Good", slides: [slide("1")] });
    d.prepare("insert into decks (id, deck_json, created_at) values ('d_bad', '{nope', 1)").run();
    expect(s.list().map((x) => x.title)).toEqual(["Good"]);
    expect(s.get("d_bad")).toBeNull();
  });
});
