/**
 * Where everything of the orbital screen goes. The screen is the 1600 x 900 canvas of the approved mockup, scaled to the window:
 * every instrument has a fixed place on that canvas, so the screen looks like the mockup at any size. Pure maths; no component
 * places anything by its own numbers.
 */

export const DESIGN_W = 1600;
export const DESIGN_H = 900;
/** Below this width there is no orbit: the nodes become a row of chips and the instruments stack. */
export const COMPACT_MAX_WIDTH = 899;
/** The orbit is this wide on the canvas. */
export const ORBIT_R = 300;
/** How far a node reaches beyond the orbit line (its radius and its glow), in pixels. */
export const NODE_MARGIN = 40;
/** The stage's orb at size 1 is about 0.37 of the window height wide; this brings it to the mockup's size (a third of the orbit). */
export const ORBITAL_ORB_SCALE = 0.31;
/** The mockup's node places: top, upper right, lower right, lower left, upper left. The bottom is kept for the usage label. */
export const ORBIT_SLOTS = [-90, -30, 30, 150, 210] as const;
const MIN_ORBIT = 120;
const MAX_NODES = 12;

export type Anchor = "left" | "right" | "centre";
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How many pixels one canvas unit is. */
export function designScale(w: number, h: number): number {
  return Math.min(w / DESIGN_W, h / DESIGN_H);
}

/** A point of the canvas on the screen. Left things keep to the left edge, right things to the right edge, the rest to the middle. */
export function screenOf(anchor: Anchor, x: number, y: number, w: number, h: number): { x: number; y: number } {
  const s = designScale(w, h);
  const left = anchor === "left" ? 0 : anchor === "right" ? w - DESIGN_W * s : (w - DESIGN_W * s) / 2;
  return { x: round2(left + x * s), y: round2((h - DESIGN_H * s) / 2 + y * s) };
}

export function orbitRadius(w: number, h: number): number {
  return Math.max(MIN_ORBIT, ORBIT_R * designScale(w, h));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The nodes of the orbit: the mockup's slots for up to five, an even ring from the top for more. */
export function orbitNodes(count: number, w: number, h: number): { x: number; y: number; angle: number }[] {
  const n = Math.max(0, Math.min(MAX_NODES, Math.floor(count)));
  const r = orbitRadius(w, h);
  return Array.from({ length: n }, (_, i) => {
    const angle = n <= ORBIT_SLOTS.length ? ORBIT_SLOTS[i]! : -90 + (i * 360) / n;
    const rad = (angle * Math.PI) / 180;
    return { x: round2(w / 2 + r * Math.cos(rad)), y: round2(h / 2 + r * Math.sin(rad)), angle };
  });
}

/** The circle the orbit and its nodes occupy. */
export function centreClear(w: number, h: number): { cx: number; cy: number; r: number } {
  return { cx: w / 2, cy: h / 2, r: orbitRadius(w, h) + NODE_MARGIN };
}

export function layoutMode(w: number, _h: number): "orbit" | "compact" {
  return w <= COMPACT_MAX_WIDTH ? "compact" : "orbit";
}