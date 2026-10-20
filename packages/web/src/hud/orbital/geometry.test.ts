import { describe, expect, it } from "vitest";
import { DESIGN_H, DESIGN_W, ORBIT_SLOTS, centreClear, designScale, layoutMode, orbitNodes, orbitRadius, screenOf } from "./geometry";

describe("the design canvas", () => {
  it("is the 1600 by 900 canvas of the approved mockup, scaled to fit the window", () => {
    expect([DESIGN_W, DESIGN_H]).toEqual([1600, 900]);
    expect(designScale(1920, 1080)).toBeCloseTo(1.2, 5);
    expect(designScale(1600, 900)).toBe(1);
    expect(designScale(1366, 768)).toBeCloseTo(0.8537, 3);
    expect(designScale(1080, 1920)).toBeCloseTo(0.675, 3); // a tall window is limited by its width
  });

  it("puts a point of the canvas on the screen: left things hug the left edge, right things the right edge, the rest the middle", () => {
    expect(screenOf("left", 40, 90, 1920, 1080)).toEqual({ x: 48, y: 108 });
    expect(screenOf("right", 1560, 90, 1920, 1080)).toEqual({ x: 1872, y: 108 });
    expect(screenOf("centre", 800, 450, 1920, 1080)).toEqual({ x: 960, y: 540 });
    // a wider window keeps the rails at its edges and the orb in the middle
    expect(screenOf("left", 40, 90, 2560, 1080).x).toBe(48);
    expect(screenOf("right", 1560, 90, 2560, 1080).x).toBe(2560 - 48);
    expect(screenOf("centre", 800, 450, 2560, 1080).x).toBe(1280);
    // a taller window centres the canvas vertically
    expect(screenOf("centre", 800, 450, 1600, 1200).y).toBe(600);
  });
});

describe("the orbit", () => {
  it("is 300 canvas units wide, as in the mockup, and never below 120 pixels", () => {
    expect(orbitRadius(1920, 1080)).toBeCloseTo(360, 5);
    expect(orbitRadius(1600, 900)).toBe(300);
    expect(orbitRadius(900, 300)).toBeGreaterThanOrEqual(120);
  });

  it("uses the mockup's five slots: top, upper right, lower right, lower left, upper left (the bottom is left for the usage label)", () => {
    expect(ORBIT_SLOTS).toEqual([-90, -30, 30, 150, 210]);
    const nodes = orbitNodes(5, 1600, 900);
    expect(nodes.map((n) => n.angle)).toEqual([-90, -30, 30, 150, 210]);
    expect(nodes[0]!.x).toBeCloseTo(800, 1);
    expect(nodes[0]!.y).toBeCloseTo(150, 1);
    expect(nodes[1]!.x).toBeCloseTo(1059.81, 1);
    expect(nodes[1]!.y).toBeCloseTo(300, 1);
  });

  it("fills the slots in order for fewer nodes", () => {
    expect(orbitNodes(3, 1600, 900).map((n) => n.angle)).toEqual([-90, -30, 30]);
    expect(orbitNodes(1, 1600, 900).map((n) => n.angle)).toEqual([-90]);
  });

  it("spaces more than five evenly, from the top, and has none for none, and at most twelve", () => {
    expect(orbitNodes(8, 1600, 900).map((n) => n.angle)).toEqual([-90, -45, 0, 45, 90, 135, 180, 225]);
    expect(orbitNodes(0, 1600, 900)).toEqual([]);
    expect(orbitNodes(-2, 1600, 900)).toEqual([]);
    expect(orbitNodes(20, 1600, 900)).toHaveLength(12);
  });

  it("clears a circle one node-width beyond the orbit", () => {
    const c = centreClear(1920, 1080);
    expect(c).toEqual({ cx: 960, cy: 540, r: 360 + 40 });
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