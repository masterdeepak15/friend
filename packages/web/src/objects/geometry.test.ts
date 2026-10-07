import { describe, expect, it } from "vitest";
import { arcPath, circleLayout, gaugeAngle, linePath, niceScale, scaleLinear, shortenSegment } from "./geometry";

describe("niceScale", () => {
  it("rounds 0..97 to 0..100 with five round ticks", () => {
    const s = niceScale(0, 97, 5);
    expect(s.min).toBe(0);
    expect(s.max).toBe(100);
    expect(s.ticks).toEqual([0, 25, 50, 75, 100]);
  });
  it("expands a flat range instead of dividing by zero", () => {
    const s = niceScale(5, 5, 5);
    expect(s.max).toBeGreaterThan(s.min);
    expect(s.ticks.length).toBeGreaterThan(1);
  });
  it("handles negative and reversed input", () => {
    const s = niceScale(10, -20, 5);
    expect(s.min).toBeLessThanOrEqual(-20);
    expect(s.max).toBeGreaterThanOrEqual(10);
  });
  it("never returns NaN for non-finite input", () => {
    const s = niceScale(Number.NaN, Number.POSITIVE_INFINITY, 5);
    expect(Number.isFinite(s.min)).toBe(true);
    expect(Number.isFinite(s.max)).toBe(true);
  });
});

describe("scaleLinear", () => {
  it("maps domain endpoints to range endpoints and the middle to the middle", () => {
    const f = scaleLinear([0, 10], [100, 200]);
    expect(f(0)).toBe(100);
    expect(f(10)).toBe(200);
    expect(f(5)).toBe(150);
  });
  it("returns the range start for an empty domain", () => {
    expect(scaleLinear([3, 3], [0, 50])(3)).toBe(0);
  });
});

describe("linePath", () => {
  it("is one M followed by n-1 L segments", () => {
    const d = linePath([[0, 0], [1, 2], [2, 1]]);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/L/g)).toHaveLength(2);
  });
  it("is empty for no points", () => {
    expect(linePath([])).toBe("");
  });
});

describe("arcPath", () => {
  it("starts with M and contains an arc with the large-arc flag only past 180 degrees", () => {
    const small = arcPath(50, 50, 40, 0, 90);
    const large = arcPath(50, 50, 40, 0, 240);
    expect(small.startsWith("M")).toBe(true);
    expect(small).toMatch(/A 40 40 0 0 1/);
    expect(large).toMatch(/A 40 40 0 1 1/);
  });
});

describe("gaugeAngle", () => {
  it("maps min..max to 0..240 degrees and clamps outside", () => {
    expect(gaugeAngle(0, 0, 100)).toBe(0);
    expect(gaugeAngle(50, 0, 100)).toBe(120);
    expect(gaugeAngle(100, 0, 100)).toBe(240);
    expect(gaugeAngle(-5, 0, 100)).toBe(0);
    expect(gaugeAngle(500, 0, 100)).toBe(240);
  });
  it("returns 0 for NaN or an empty range", () => {
    expect(gaugeAngle(Number.NaN, 0, 100)).toBe(0);
    expect(gaugeAngle(5, 10, 10)).toBe(0);
  });
});

describe("shortenSegment", () => {
  it("trims both ends of a segment by the given radii", () => {
    const s = shortenSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 20);
    expect(s.from.x).toBeCloseTo(10, 5);
    expect(s.to.x).toBeCloseTo(80, 5);
    expect(s.from.y).toBeCloseTo(0, 5);
  });
  it("works along any direction", () => {
    const s = shortenSegment({ x: 0, y: 0 }, { x: 30, y: 40 }, 5, 5);
    expect(Math.hypot(s.from.x, s.from.y)).toBeCloseTo(5, 5);
    expect(Math.hypot(30 - s.to.x, 40 - s.to.y)).toBeCloseTo(5, 5);
  });
  it("leaves coincident or too-close points unchanged instead of producing NaN", () => {
    const same = shortenSegment({ x: 5, y: 5 }, { x: 5, y: 5 }, 10, 10);
    expect(same.from).toEqual({ x: 5, y: 5 });
    const close = shortenSegment({ x: 0, y: 0 }, { x: 4, y: 0 }, 10, 10);
    expect(Number.isFinite(close.from.x) && Number.isFinite(close.to.x)).toBe(true);
  });
});

describe("circleLayout", () => {
  it("returns no points for zero and the center for one", () => {
    expect(circleLayout(0, 400, 300)).toEqual([]);
    expect(circleLayout(1, 400, 300)).toEqual([{ x: 200, y: 150 }]);
  });
  it("places n distinct points inside the bounds", () => {
    const pts = circleLayout(12, 400, 300);
    expect(pts).toHaveLength(12);
    expect(new Set(pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)).size).toBe(12);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(400);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(300);
    }
  });
});
