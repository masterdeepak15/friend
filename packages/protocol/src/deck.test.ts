import { describe, expect, it } from "vitest";
import { DECK_LIMITS, StageCommand, TOOL_DEFS, deckProblem, describeCall, withIds, type Deck } from "./index";

const item = (id: string, extra: object = {}) => ({ id, kind: "text", content: { text: "A point" }, say: "Here is a point.", ...extra });
const slide = (id: string, n = 2, layout = "bullets") => ({ id, title: `Slide ${id}`, layout, items: Array.from({ length: n }, (_, i) => item(`${id}-${i}`)) });
const deck = (slides: unknown[]): unknown => ({ id: "d_1", title: "Hacking", slides, createdAt: 1 });

describe("what a deck may be", () => {
  it("accepts a small deck", () => {
    expect(deckProblem(deck([slide("a"), slide("b"), slide("c", 1, "visual")]))).toBeNull();
  });

  it("refuses more than forty slides and says the limit", () => {
    const many = Array.from({ length: DECK_LIMITS.slides + 1 }, (_, i) => slide(`s${i}`, 1));
    expect(deckProblem(deck(many))).toMatch(/at most 40 slides/);
  });

  it("refuses a slide with more items than its layout fits, and tells the assistant to split it", () => {
    const msg = deckProblem(deck([slide("a", 6)]));
    expect(msg).toMatch(/Slide 1/);
    expect(msg).toMatch(/fits 5/);
    expect(msg).toMatch(/split/);
  });

  it("refuses a spoken line that is too long, an unknown animation or layout, and repeated ids", () => {
    expect(deckProblem(deck([{ ...slide("a", 0), items: [item("x", { say: "w".repeat(401) })] }]))).toBeTruthy();
    expect(deckProblem(deck([{ ...slide("a", 0), items: [item("x", { animation: "spin" })] }]))).toBeTruthy();
    expect(deckProblem(deck([slide("a", 1, "carousel")]))).toBeTruthy();
    expect(deckProblem(deck([slide("a", 1), slide("a", 1)]))).toMatch(/same id/);
    expect(deckProblem(deck([{ ...slide("a", 0), items: [item("x"), item("x")] }]))).toMatch(/same id|two items/);
  });

  it("knows the kinds: text, and the stage object types", () => {
    expect(deckProblem(deck([{ ...slide("a", 0), items: [item("x", { kind: "chart", content: { kind: "bar", labels: [], series: [] } })] }]))).toBeNull();
    expect(deckProblem(deck([{ ...slide("a", 0), items: [item("x", { kind: "spaceship" })] }]))).toMatch(/unknown kind/);
    expect(deckProblem(deck([{ ...slide("a", 0), items: [item("x", { content: {} })] }]))).toMatch(/content\.text/);
  });

  it("gives ids to slides and items that come without", () => {
    const filled = withIds([{ title: "T", layout: "bullets", items: [{ kind: "text", content: { text: "x" }, say: "x" }] }]);
    expect(filled[0]!.id).toBeTruthy();
    expect(filled[0]!.items[0]!.id).toBeTruthy();
    expect(new Set([filled[0]!.id, filled[0]!.items[0]!.id]).size).toBe(2);
  });
});

describe("the deck on the screens and the tools", () => {
  const view = { deckId: "d_1", title: "Hacking", index: 0, total: 1, slide: slide("a", 2), shown: 1, state: "playing" };
  it("is a stage command; null puts it away; showing more than there is, is refused", () => {
    expect(StageCommand.safeParse({ cmd: "deck", view }).success).toBe(true);
    expect(StageCommand.safeParse({ cmd: "deck", view: null }).success).toBe(true);
    expect(StageCommand.safeParse({ cmd: "deck", view: { ...view, shown: 3 } }).success).toBe(false);
  });

  it("has a tool for each thing the assistant does with a deck, all on the gateway", () => {
    const names = ["create", "edit", "list", "show", "present", "control", "export", "delete"].map((n) => `deck.${n}`);
    for (const n of names) expect(TOOL_DEFS.find((t) => t.name === n)?.target).toBe("gateway");
    expect(TOOL_DEFS.find((t) => t.name === "deck.delete")!.baseTier).not.toBe("T0");
    expect(TOOL_DEFS.find((t) => t.name === "deck.export")!.baseTier).not.toBe("T0");
    expect(TOOL_DEFS.find((t) => t.name === "deck.list")!.readOnly).toBe(true);
    expect(TOOL_DEFS.find((t) => t.name === "deck.control")!.input.safeParse({ action: "next" }).success).toBe(true);
    expect(TOOL_DEFS.find((t) => t.name === "deck.control")!.input.safeParse({ action: "dance" }).success).toBe(false);
  });

  it("says what a deck call does on an approval card", () => {
    expect(describeCall("deck.delete", { id: "d_1" })).toMatch(/Delete/);
    expect(describeCall("deck.export", { id: "d_1", format: "pptx" })).toMatch(/pptx/);
  });
});

export type { Deck };
