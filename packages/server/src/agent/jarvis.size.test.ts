import type { ScreenInfo, StageObject } from "@friend/protocol";
import { jarvisNaturalSize } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { placeObject } from "./layout";

const desktop: ScreenInfo = { kind: "desktop", orientation: "landscape", width: 1920, height: 1080, touch: false };
const stat = { c: "JStatCard", p: { title: "CPU", value: "15%", barValue: 15 } };
const jarvis = (placement: StageObject["placement"], ui: unknown = stat, id = "cpu"): StageObject => ({ id, type: "jarvis", props: { ui }, placement });
const box = (o: StageObject) => o.placement as { x: number; y: number; w: number; h: number };

describe("giving a Jarvis card the size its content needs", () => {
  it("shrinks a box that is far bigger than the card, so it is not a small card lost in a big square", () => {
    const r = placeObject(jarvis({ x: 0.03, y: 0.12, w: 0.28, h: 0.26 }), [], [], desktop);
    const nat = jarvisNaturalSize(stat as never);
    expect(box(r.object).w * 1920).toBeLessThan(nat.w * 1.3);
    expect(box(r.object).w * 1920).toBeGreaterThanOrEqual(nat.w);
    expect(box(r.object).h * 1080).toBeGreaterThanOrEqual(nat.h + 28); // the title bar too
    expect(box(r.object).x).toBe(0.03); // where it was put stays
    expect(r.note).toMatch(/size/i);
  });

  it("grows a box that is too small for what is in it", () => {
    const r = placeObject(jarvis({ x: 0.1, y: 0.2, w: 0.05, h: 0.05 }), [], [], desktop);
    expect(box(r.object).w * 1920).toBeGreaterThanOrEqual(jarvisNaturalSize(stat as never).w);
    expect(box(r.object).h * 1080).toBeGreaterThanOrEqual(jarvisNaturalSize(stat as never).h);
  });

  it("gives a named place a box of the right size, in the middle of that place", () => {
    const r = placeObject(jarvis("left"), [], [], desktop);
    const b = box(r.object);
    expect(typeof r.object.placement).toBe("object");
    expect(b.w).toBeLessThan(0.25);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(0.6);
  });

  it("makes a bigger drawing bigger, up to most of the screen", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ c: "JStatCard", p: { title: `S${i}`, value: "1" } }));
    const r = placeObject(jarvis({ x: 0.05, y: 0.12, w: 0.1, h: 0.1 }, { c: "Grid", p: { columns: 3 }, kids: rows }), [], [], desktop);
    expect(box(r.object).w).toBeGreaterThan(0.35);
    expect(box(r.object).w).toBeLessThanOrEqual(0.9);
    expect(box(r.object).h).toBeLessThanOrEqual(0.75);
  });

  it("leaves auto, a phone and every other kind of object alone", () => {
    expect(placeObject(jarvis("auto"), [], [], desktop).object.placement).toBe("auto");
    expect(placeObject(jarvis({ x: 0.1, y: 0.2, w: 0.3, h: 0.3 }), [], [], { ...desktop, kind: "phone", width: 390, height: 800 }).object.placement).toBe("auto");
    const card: StageObject = { id: "c", type: "card", props: { text: "x" }, placement: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } };
    expect(placeObject(card, [], [], desktop).object.placement).toEqual(card.placement);
  });

  it("assumes a wide desktop when the screen is not known, and does not fail on a broken tree", () => {
    expect(typeof placeObject(jarvis("center"), [], [], null).object.placement).toBe("object");
    expect(() => placeObject({ id: "x", type: "jarvis", props: {}, placement: "left" }, [], [], desktop)).not.toThrow();
  });
});