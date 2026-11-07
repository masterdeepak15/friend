import { INSTRUMENT_RECTS, ObjectRole, SAFE, overlap, rectOf, type Rect, type ScreenInfo, type StageObject } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { composeScreen, restoreScreen, type ComposeItem, type ComposeState } from "./compose";

const screen = (width: number, height: number, kind: ScreenInfo["kind"], touch = false): ScreenInfo => ({ width, height, kind, orientation: height > width ? "portrait" : "landscape", touch });
const DESKTOP = screen(1920, 1080, "desktop");
const PHONE = screen(390, 844, "phone", true);
const state = (over: Partial<ComposeState> = {}): ComposeState => ({ screen: DESKTOP, panels: [], instruments: [], current: [], ownerPlaced: new Set(), ...over });
const item = (id: string, role: ComposeItem["role"], extra: Partial<ComposeItem> = {}): ComposeItem => ({ id, type: "card", props: { title: id, text: id }, role, ...extra });
const cur = (id: string, extra: Partial<StageObject> = {}): StageObject => ({ id, type: "card", props: { text: id }, placement: "auto", ...extra });
const box = (o: StageObject): Rect => {
  const r = rectOf(o.placement);
  if (!r) throw new Error(`${o.id} has no box`);
  return r;
};
const shown = (r: ReturnType<typeof composeScreen>, id: string) => r.show.find((o) => o.id === id);

describe("composeScreen: roles to places", () => {
  it("a focus alone goes to the focus zone; a big one asks for the focus scene, a small one does not", () => {
    const small = composeScreen([item("a", "focus")], "replace", state());
    expect(shown(small, "a")?.role).toBe("focus");
    expect(small.scene).toBe("conversation");
    const big = composeScreen([{ id: "p", type: "sandbox", props: { html: "<p>x</p>" }, role: "focus" }], "replace", state());
    expect(big.scene).toBe("focus");
    expect(box(shown(big, "p")!)[2]).toBeGreaterThan(box(shown(small, "a")!)[2]);
  });

  it("one focus and two beside fill right then left and never overlap", () => {
    const r = composeScreen([item("f", "focus"), item("b1", "beside"), item("b2", "beside")], "replace", state());
    const boxes = ["f", "b1", "b2"].map((id) => box(shown(r, id)!));
    expect(boxes[1]![0]).toBeGreaterThan(70);
    expect(boxes[2]![0]).toBeLessThan(10);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(overlap(boxes[i]!, boxes[j]!)).toBeLessThan(0.01);
    expect(r.scene).toBe("multi");
  });

  it("a fourth card beyond capacity docks the oldest current beside and says so", () => {
    const current = [cur("old1", { role: "beside" }), cur("old2", { role: "beside" }), cur("old3", { role: "beside" })];
    const r = composeScreen([item("new", "beside")], "add", state({ current }));
    expect(r.dock).toEqual(["old1"]);
    expect(r.notes.join(" ")).toMatch(/old1/);
    expect(shown(r, "new")).toBeDefined();
  });

  it("a glance becomes a docked chip with a label", () => {
    const r = composeScreen([{ id: "t", type: "stat", props: { label: "Temp", value: 24 }, role: "glance", label: "24 C" }], "replace", state());
    expect(shown(r, "t")).toMatchObject({ docked: true, role: "glance", label: "24 C" });
  });

  it("chips beyond the limit drop the oldest chip and say so", () => {
    const current = [cur("c1", { docked: true, role: "glance" }), cur("c2", { docked: true, role: "glance" })];
    const r = composeScreen([item("c3", "glance")], "add", state({ current, maxChips: 2 }));
    expect(r.hide).toEqual(["c1"]);
    expect(r.notes.join(" ")).toMatch(/c1/);
  });

  it("a note is an overlay with a time between 15 and 60 seconds", () => {
    const r = composeScreen([item("n", "note", { ttl: 500 }), item("m", "note", { ttl: 2 })], "add", state());
    expect(shown(r, "n")).toMatchObject({ layer: "overlay", ttl: 60 });
    expect(shown(r, "m")).toMatchObject({ layer: "overlay", ttl: 15 });
  });

  it("an alert shows alone in alert style and docks what was there, nothing lost", () => {
    const current = [cur("f", { role: "focus" }), cur("b", { role: "beside" }), cur("w", { pinned: true })];
    const r = composeScreen([item("bad", "alert")], "replace", state({ current }));
    expect(shown(r, "bad")).toMatchObject({ style: "alert" });
    expect(r.scene).toBe("focus");
    expect(r.dock.sort()).toEqual(["b", "f"]);
    expect(r.hide).not.toContain("w");
    expect(r.dock).not.toContain("w");
  });

  it("replace docks the previous focus and beside objects, add keeps them", () => {
    const current = [cur("f", { role: "focus" }), cur("b", { role: "beside" })];
    expect(composeScreen([item("n", "focus")], "replace", state({ current })).dock.sort()).toEqual(["b", "f"]);
    expect(composeScreen([item("n", "beside")], "add", state({ current })).dock).toEqual([]);
  });

  it("replace hides passing notes of the old screen", () => {
    const current = [cur("n", { role: "note", layer: "overlay" })];
    expect(composeScreen([item("f", "focus")], "replace", state({ current })).hide).toEqual(["n"]);
  });

  it("pinned widgets are never hidden, docked or moved", () => {
    const current = [cur("w", { pinned: true, placement: { x: 0.8, y: 0.1, w: 0.15, h: 0.2 } })];
    const r = composeScreen([item("f", "focus")], "replace", state({ current }));
    expect([...r.hide, ...r.dock]).not.toContain("w");
  });

  it("an object the owner placed keeps its place when the same id is composed again", () => {
    const placement = { x: 0.1, y: 0.2, w: 0.3, h: 0.3 };
    const current = [cur("a", { role: "beside", placement })];
    const r = composeScreen([item("a", "beside")], "add", state({ current, ownerPlaced: new Set(["a"]) }));
    expect(shown(r, "a")?.placement).toEqual(placement);
  });

  it("the same id twice in one call is refused with a plain sentence", () => {
    expect(() => composeScreen([item("a", "focus"), item("a", "beside")], "replace", state())).toThrow(/twice/);
  });

  it("the same id composed again updates in place: one show, not two", () => {
    const current = [cur("a", { role: "focus" })];
    const r = composeScreen([item("a", "focus")], "add", state({ current }));
    expect(r.show.filter((o) => o.id === "a")).toHaveLength(1);
    expect(r.dock).toEqual([]);
  });
});

describe("composeScreen: small screens and limits", () => {
  it("a phone stacks: the focus first, one beside, the rest docked", () => {
    const r = composeScreen([item("f", "focus"), item("b1", "beside"), item("b2", "beside")], "replace", state({ screen: PHONE }));
    expect(shown(r, "f")?.placement).toBe("auto");
    expect(shown(r, "b1")?.placement).toBe("auto");
    expect(shown(r, "b2")).toMatchObject({ docked: true });
  });

  it("a small landscape screen keeps every box inside the safe area", () => {
    const r = composeScreen([item("f", "focus"), item("b1", "beside"), item("b2", "beside")], "replace", state({ screen: screen(667, 375, "tablet", true) }));
    for (const o of r.show) {
      const b = box(o);
      expect(b[0]).toBeGreaterThanOrEqual(SAFE[0] - 0.01);
      expect(b[1] + b[3]).toBeLessThanOrEqual(SAFE[1] + SAFE[3] + 0.01);
    }
  });

  it("instruments on the right take the right slots away", () => {
    const r = composeScreen([item("f", "focus"), item("b1", "beside"), item("b2", "beside")], "replace", state({ instruments: ["radar", "tickets"] }));
    for (const id of ["b1", "b2"]) {
      const o = shown(r, id)!;
      if (!o.docked) expect(overlap(box(o), INSTRUMENT_RECTS.radar)).toBeLessThan(0.25);
    }
    expect(r.show.filter((o) => !o.docked && o.role === "beside")).toHaveLength(1);
    expect(r.show.filter((o) => o.docked)).toHaveLength(1);
  });

  it("more than the twelve-object limit drops the oldest chips, and past that refuses cleanly", () => {
    const chips = Array.from({ length: 6 }, (_, i) => cur(`c${i}`, { docked: true, role: "glance" }));
    const fine = composeScreen(Array.from({ length: 8 }, (_, i) => item(`n${i}`, "note")), "add", state({ current: chips, maxChips: 12 }));
    expect(fine.hide.length).toBeGreaterThanOrEqual(2);
    const pinned = Array.from({ length: 6 }, (_, i) => cur(`p${i}`, { pinned: true }));
    expect(() => composeScreen(Array.from({ length: 8 }, (_, i) => item(`n${i}`, "beside")), "add", state({ current: [...pinned, ...Array.from({ length: 6 }, (_, i) => cur(`x${i}`, { role: "beside" }))] }))).toThrow(/limit/i);
  });

  it("an unknown role or no items is a plain error", () => {
    expect(() => composeScreen([item("a", "hero" as never)], "replace", state())).toThrow(/role/);
    expect(() => composeScreen([], "replace", state())).toThrow(/nothing/i);
  });

  it("knows exactly five roles", () => {
    expect(ObjectRole.options).toEqual(["focus", "beside", "glance", "note", "alert"]);
  });
});

describe("restoreScreen", () => {
  it("brings a chip back into a free slot", () => {
    const current = [cur("f", { role: "focus" }), cur("c", { docked: true, role: "beside" })];
    const r = restoreScreen("c", state({ current }));
    expect(r.undock).toEqual(["c"]);
    expect(r.show.find((o) => o.id === "c")?.docked).toBeUndefined();
  });

  it("docks the oldest beside when the zone is full", () => {
    const current = [cur("b1", { role: "beside" }), cur("b2", { role: "beside" }), cur("b3", { role: "beside" }), cur("c", { docked: true, role: "beside" })];
    const r = restoreScreen("c", state({ current }));
    expect(r.undock).toEqual(["c"]);
    expect(r.dock).toEqual(["b1"]);
  });

  it("an unknown id is a plain error", () => {
    expect(() => restoreScreen("zz", state())).toThrow(/zz/);
  });
});

describe("review fixes", () => {
  it("an alert stays shown when more is added: not shrunk into a side card, not put away", () => {
    const phone = composeScreen([item("bad", "alert")], "replace", state({ screen: PHONE }));
    const withAlert = phone.show;
    const r = composeScreen([item("b", "beside")], "add", state({ screen: PHONE, current: withAlert }));
    expect(r.dock).not.toContain("bad");
    const desk = composeScreen([item("bad", "alert")], "replace", state());
    const again = composeScreen([item("b", "beside")], "add", state({ current: desk.show }));
    const kept = again.show.find((o) => o.id === "bad");
    if (kept) expect(box(kept)[2]).toBeGreaterThan(40);
    expect(again.dock).not.toContain("bad");
  });

  it("a big focus never sits on a card beside it", () => {
    for (const s of [DESKTOP, screen(1024, 768, "tablet", true)]) {
      const r = composeScreen([{ id: "p", type: "sandbox", props: { html: "<p>x</p>" }, role: "focus" }, item("b", "beside")], "replace", state({ screen: s }));
      const f = box(shown(r, "p")!);
      const b = shown(r, "b")!;
      if (!b.docked) expect(overlap(f, box(b))).toBeLessThan(0.01);
    }
  });

  it("with the chip limit switched off (a screen change) no chip is dropped", () => {
    const current = ["c1", "c2", "c3"].map((id) => cur(id, { docked: true, role: "glance" }));
    const r = composeScreen([item("n", "beside")], "add", state({ current, maxChips: 2, keepChips: true }));
    expect(r.hide).toEqual([]);
  });
});
