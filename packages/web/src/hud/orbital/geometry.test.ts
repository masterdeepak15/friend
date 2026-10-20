import { describe, expect, it } from "vitest";
import { centreClear, layoutMode, orbitNodes, orbitRadius, zoneRect, type ZoneId } from "./geometry";

const ZONES: ZoneId[] = ["top", "left-top", "left-mid", "left-bottom", "right-top", "right-mid", "right-bottom", "bottom"];
const VIEWPORTS: [number, number][] = [
  [1920, 1080],
  [1366, 768],
  [2560, 1080],
  [1080, 1920],
];

describe("the orbit", () => {
  it("is a third of the smaller side, and never below 120", () => {
    expect(orbitRadius(1920, 1080)).toBeCloseTo(356.4, 1);
    expect(orbitRadius(900, 300)).toBeGreaterThanOrEqual(120);
  });

  it("puts the first node at the top and spaces the others evenly", () => {
    const [first, second, third, fourth] = orbitNodes(4, 1920, 1080);
    expect(first!.angle).toBe(-90);
    expect(first!.x).toBeCloseTo(960, 1);
    expect(first!.y).toBeCloseTo(540 - orbitRadius(1920, 1080), 1);
    expect(second!.angle - first!.angle).toBe(90);
    expect(third!.angle - second!.angle).toBe(90);
    expect(fourth!.angle - third!.angle).toBe(90);
  });

  it("has no nodes for none, and at most twelve", () => {
    expect(orbitNodes(0, 1920, 1080)).toEqual([]);
    expect(orbitNodes(-3, 1920, 1080)).toEqual([]);
    expect(orbitNodes(20, 1920, 1080)).toHaveLength(12);
  });
});

describe("the zones around the clear centre", () => {
  for (const [w, h] of VIEWPORTS) {
    it(`keep inside the window and off the centre at ${w}x${h}`, () => {
      const c = centreClear(w, h);
      const box = { x: c.cx - c.r, y: c.cy - c.r, width: 2 * c.r, height: 2 * c.r };
      for (const id of ZONES) {
        const z = zoneRect(id, w, h);
        expect(z.x, id).toBeGreaterThanOrEqual(0);
        expect(z.y, id).toBeGreaterThanOrEqual(0);
        expect(z.x + z.width, id).toBeLessThanOrEqual(w);
        expect(z.y + z.height, id).toBeLessThanOrEqual(h);
        const overlaps = z.x < box.x + box.width && z.x + z.width > box.x && z.y < box.y + box.height && z.y + z.height > box.y;
        expect(overlaps, `${id} overlaps the centre`).toBe(false);
      }
    });
  }

  it("never overlap each other", () => {
    const [w, h] = [1920, 1080];
    for (let i = 0; i < ZONES.length; i++)
      for (let j = i + 1; j < ZONES.length; j++) {
        const a = zoneRect(ZONES[i]!, w, h);
        const b = zoneRect(ZONES[j]!, w, h);
        const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlaps, `${ZONES[i]} and ${ZONES[j]}`).toBe(false);
      }
  });
});

describe("the layout mode", () => {
  it("is compact on a phone and a narrow tablet, and an orbit from 900 wide", () => {
    expect(layoutMode(599, 900)).toBe("compact");
    expect(layoutMode(899, 600)).toBe("compact");
    expect(layoutMode(900, 600)).toBe("orbit");
    expect(layoutMode(1920, 1080)).toBe("orbit");
  });
});
