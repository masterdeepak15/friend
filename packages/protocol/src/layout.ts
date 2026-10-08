import type { Placement } from "./stage";

/** A box on the stage in percent of the screen: x, y, width, height. */
export type Rect = readonly [x: number, y: number, w: number, h: number];

/** Where the named placements put an object on a wide screen. On a phone everything is stacked instead. */
export const REGIONS = {
  center: [20, 18, 60, 58],
  left: [3, 12, 30, 70],
  right: [67, 12, 30, 70],
  top: [20, 4, 60, 30],
  bottom: [20, 62, 60, 30],
} as const satisfies Record<string, Rect>;

export type RegionName = keyof typeof REGIONS;
export const REGION_NAMES = Object.keys(REGIONS) as RegionName[];

/**
 * The part of the screen an explicitly drawn box must stay inside. The top strip holds the owner menu, microphone
 * badge and notices; the bottom strip holds the live captions, the status line and the clock.
 */
export const SAFE: Rect = [2, 10, 96, 68];

/** The box of a placement, or null for "auto" (which flows in a grid instead). */
export function rectOf(p: Placement): Rect | null {
  if (p === "auto") return null;
  if (typeof p === "string") return REGIONS[p];
  return [p.x * 100, p.y * 100, p.w * 100, p.h * 100];
}

/** How much of the smaller box is covered by the other one, 0 to 1. */
export function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min(a[2] * a[3], b[2] * b[3]);
}

/** Moves and shrinks a box so it lies inside the safe part of the screen (and is not tiny). */
export function clampToSafe(r: Rect): Rect {
  const [sx, sy, sw, sh] = SAFE;
  const w = Math.min(Math.max(r[2], 12), sw);
  const h = Math.min(Math.max(r[3], 10), sh);
  const x = Math.min(Math.max(r[0], sx), sx + sw - w);
  const y = Math.min(Math.max(r[1], sy), sy + sh - h);
  const round = (n: number) => Math.round(n * 100) / 100;
  return [round(x), round(y), round(w), round(h)];
}
