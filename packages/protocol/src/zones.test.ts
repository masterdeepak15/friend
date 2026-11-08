import { describe, expect, it } from "vitest";
import { overlap, SAFE, type Rect } from "./layout";
import type { ScreenInfo } from "./messages";
import type { StageObject } from "./stage";
import { chipOf, hudInstrumentsOn, INSTRUMENT_RECTS, isBig, readSeconds, zonesFor } from "./zones";

const screen = (width: number, height: number, kind: ScreenInfo["kind"], touch = false): ScreenInfo => ({ width, height, kind, orientation: height > width ? "portrait" : "landscape", touch });
const SIZES: [string, ScreenInfo, number][] = [
  ["desktop 1920x1080", screen(1920, 1080, "desktop"), 3],
  ["desktop 1366x768", screen(1366, 768, "desktop"), 3],
  ["tablet 1024x768", screen(1024, 768, "tablet", true), 2],
  ["tablet 768x1024", screen(768, 1024, "tablet", true), 2],
  ["phone 390x844", screen(390, 844, "phone", true), 0],
  ["small landscape 667x375", screen(667, 375, "tablet", true), 2],
];
const inside = (r: Rect) => r[0] >= SAFE[0] - 0.01 && r[1] >= SAFE[1] - 0.01 && r[0] + r[2] <= SAFE[0] + SAFE[2] + 0.01 && r[1] + r[3] <= SAFE[1] + SAFE[3] + 0.01;
const obj = (o: Partial<StageObject> & { type: string }): StageObject => ({ id: "x", props: {}, placement: "auto", ...o });

describe("zonesFor", () => {
  for (const [name, s, capacity] of SIZES) {
    it(`${name}: zones are inside the safe area, never overlap, and hold ${capacity} beside`, () => {
      const z = zonesFor(s);
      const all = [z.focus, ...z.beside];
      for (const r of all) expect(inside(r)).toBe(true);
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!)).toBeLessThan(0.01);
      expect(z.beside.length).toBe(capacity);
      expect(z.stack).toBe(s.kind === "phone");
    });
  }
  it("chip limits follow the screen and can be set", () => {
    expect(zonesFor(screen(1920, 1080, "desktop")).chipMax).toBe(7);
    expect(zonesFor(screen(1024, 768, "tablet", true)).chipMax).toBe(5);
    expect(zonesFor(screen(390, 844, "phone", true)).chipMax).toBe(5);
    expect(zonesFor(screen(1920, 1080, "desktop"), undefined, 3).chipMax).toBe(3);
    expect(zonesFor(screen(1920, 1080, "desktop"), undefined, 99).chipMax).toBe(12);
  });
  it("an unknown screen is treated as a wide desktop", () => {
    expect(zonesFor(null).beside.length).toBe(3);
  });
  it("instruments on the right take the right slots away", () => {
    const z = zonesFor(screen(1920, 1080, "desktop"), { panels: [], instruments: [INSTRUMENT_RECTS.radar, INSTRUMENT_RECTS.tickets] });
    expect(z.beside.length).toBe(1);
    for (const r of z.beside) expect(overlap(r, INSTRUMENT_RECTS.radar)).toBeLessThan(0.25);
  });
  it("with both sides taken there is no beside slot and the focus keeps at least 40% of the width", () => {
    const z = zonesFor(screen(1920, 1080, "desktop"), { panels: [], instruments: [INSTRUMENT_RECTS.radar, INSTRUMENT_RECTS.tickets, INSTRUMENT_RECTS.system] });
    expect(z.beside).toEqual([]);
    expect(z.focus[2]).toBeGreaterThanOrEqual(40);
    expect(overlap(z.focus, INSTRUMENT_RECTS.system)).toBeLessThan(0.05);
  });
  it("an open chat panel on the right takes the right slots", () => {
    const z = zonesFor(screen(1920, 1080, "desktop"), { panels: [[70, 12, 28, 62]], instruments: [] });
    expect(z.beside.length).toBe(1);
  });
});

describe("chipOf", () => {
  it("shows a stat's label, value and unit", () => {
    expect(chipOf(obj({ type: "stat", props: { label: "Temp", value: 24, unit: "C" } }))).toEqual({ label: "Temp", value: "24 C" });
  });
  it("shows a gauge as a percentage", () => {
    expect(chipOf(obj({ type: "gauge", props: { label: "CPU", value: 61 } }))).toEqual({ label: "CPU", value: "61%" });
  });
  it("falls back to the label, the title, then the id, cut to 24 characters", () => {
    expect(chipOf(obj({ type: "card", label: "Mine", props: { title: "T" } })).label).toBe("Mine");
    expect(chipOf(obj({ type: "card", props: { title: "T" } })).label).toBe("T");
    expect(chipOf(obj({ id: "weather", type: "card" })).label).toBe("weather");
    expect(chipOf(obj({ type: "card", props: { title: "y".repeat(60) } })).label.length).toBe(24);
  });
});

describe("isBig and readSeconds", () => {
  it("a sandbox page is big, a stat is not", () => {
    expect(isBig("sandbox", { html: "<p>x</p>" })).toBe(true);
    expect(isBig("stat", { label: "a", value: 1 })).toBe(false);
  });
  it("a table with many rows is big, a short one is not", () => {
    expect(isBig("table", { columns: ["a"], rows: Array.from({ length: 9 }, () => ["1"]) })).toBe(true);
    expect(isBig("table", { columns: ["a"], rows: [["1"], ["2"]] })).toBe(false);
  });
  it("reading time is letters / 15 + 1.5 seconds", () => {
    expect(readSeconds(obj({ type: "card", props: { text: "x".repeat(150) } }))).toBeCloseTo(11.5, 5);
  });
});

describe("instrument rectangles", () => {
  it("cover every instrument inside the screen", () => {
    for (const r of Object.values(INSTRUMENT_RECTS)) {
      expect(r[0]).toBeGreaterThanOrEqual(0);
      expect(r[0] + r[2]).toBeLessThanOrEqual(100.01);
    }
  });
});

describe("review fixes", () => {
  it("every zone starts below the chip strip (y 15 or more)", () => {
    for (const [, s] of SIZES) {
      const z = zonesFor(s);
      if (z.stack) continue;
      for (const r of [z.focus, z.focusBig, ...z.beside]) expect(r[1]).toBeGreaterThanOrEqual(15);
    }
  });
  it("hudInstrumentsOn follows the same rule as the screen", () => {
    expect(hudInstrumentsOn("standard", {}, [], false)).toEqual(expect.arrayContaining(["budget", "usage"]));
    expect(hudInstrumentsOn("calm", {}, [], false)).toEqual(["usage"]);
    expect(hudInstrumentsOn("standard", { budget: false }, ["radar"], false)).toEqual(expect.arrayContaining(["radar", "usage"]));
    expect(hudInstrumentsOn("standard", { budget: false }, [], false)).not.toContain("budget");
    expect(hudInstrumentsOn("calm", {}, [], true)).toContain("approval");
  });
});
