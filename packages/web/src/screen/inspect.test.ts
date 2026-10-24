import { describe, expect, it } from "vitest";
import { analyzeScreen, type Measured } from "./inspect";

const view = { w: 1920, h: 1080 };
const obj = (id: string, x: number, y: number, w: number, h: number, over: Partial<Measured> = {}): Measured => ({ id, x, y, w, h, scrollW: w, scrollH: h, drawn: true, ...over });
const hud = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h });

describe("looking at the screen after something was drawn", () => {
  it("says so when everything fits and nothing overlaps", () => {
    const lines = analyzeScreen({ view, objects: [obj("a", 400, 150, 300, 200), obj("b", 800, 150, 300, 200)], hud: [hud("system", 40, 100, 260, 200)] });
    expect(lines).toEqual(["All 2 objects are fully visible, nothing overlaps."]);
  });

  it("finds an object whose content does not fit its box, and says how much room it needs", () => {
    const lines = analyzeScreen({ view, objects: [obj("table", 400, 150, 300, 200, { scrollH: 480 })], hud: [] });
    expect(lines.join("\n")).toMatch(/table: its content is cut off/);
    expect(lines.join("\n")).toMatch(/300x480/);
  });

  it("finds an object with nothing drawn in it", () => {
    expect(analyzeScreen({ view, objects: [obj("empty", 400, 150, 300, 200, { drawn: false })], hud: [] }).join("\n")).toMatch(/empty: nothing is drawn/);
  });

  it("finds a part that is outside the screen", () => {
    expect(analyzeScreen({ view, objects: [obj("far", 1800, 150, 300, 200)], hud: [] }).join("\n")).toMatch(/far: .*outside the screen/);
    expect(analyzeScreen({ view, objects: [obj("low", 400, 1000, 300, 200)], hud: [] }).join("\n")).toMatch(/low: .*outside the screen/);
  });

  it("finds two objects on top of each other, and an object on top of an instrument", () => {
    const text = analyzeScreen({ view, objects: [obj("a", 400, 150, 300, 200), obj("b", 450, 180, 300, 200)], hud: [hud("system", 380, 140, 260, 200)] }).join("\n");
    expect(text).toMatch(/a and b overlap/);
    expect(text).toMatch(/a covers the system instrument/);
  });

  it("does not complain about a small touch, and names each problem once", () => {
    const lines = analyzeScreen({ view, objects: [obj("a", 400, 150, 300, 200), obj("b", 690, 150, 300, 200)], hud: [] });
    expect(lines).toEqual(["All 2 objects are fully visible, nothing overlaps."]);
    const twice = analyzeScreen({ view, objects: [obj("a", 400, 150, 300, 200), obj("b", 450, 180, 300, 200)], hud: [] }).filter((l) => /overlap/.test(l));
    expect(twice).toHaveLength(1);
  });

  it("says plainly when nothing is on the screen", () => {
    expect(analyzeScreen({ view, objects: [], hud: [] })).toEqual(["No objects are on the screen."]);
  });

  it("stays short: at most 12 lines of at most 200 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => obj(`o${i}`, 100, 100, 300, 200, { drawn: false }));
    const lines = analyzeScreen({ view, objects: many, hud: [] });
    expect(lines.length).toBeLessThanOrEqual(12);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(200);
  });
});