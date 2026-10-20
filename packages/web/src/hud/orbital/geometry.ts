/**
 * Where everything of the orbital screen goes: the orbit around the orb and the zones of the edge instruments. Pure maths on the
 * window size; no component places anything by its own numbers.
 */

/** Below this width there is no orbit: the nodes become a row of chips and the instruments stack. */
export const COMPACT_MAX_WIDTH = 899;
/** The side rails, the top bar and the bottom bar, as fractions of the window. */
export const LEFT_RAIL = 0.19;
export const RIGHT_RAIL = 0.21;
export const TOP_BAR = 0.06;
export const BOTTOM_BAR = 0.07;
/** Space between zones, and between a zone and the orbit, in pixels. */
export const ZONE_GAP = 8;
const CLEAR_GAP = 16;
/** How far a node reaches beyond the orbit line (its radius and its glow). */
export const NODE_MARGIN = 40;
/** At size 1 the stage's orb is drawn about 1.1 times the orbit radius wide (the classic screen); this scale brings it inside the inner ring, which is 0.43 of the orbit radius, at every window size. */
export const ORBITAL_ORB_SCALE = 0.36;
const MIN_ORBIT = 120;
const MAX_NODES = 12;

export type ZoneId = "top" | "left-top" | "left-mid" | "left-bottom" | "right-top" | "right-mid" | "right-bottom" | "bottom";
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A third of the smaller side, pulled in when the window is so narrow that the side rails would otherwise touch the orbit. */
export function orbitRadius(w: number, h: number): number {
  const byHeight = 0.33 * Math.min(w, h);
  const byWidth = (w * (1 - LEFT_RAIL - RIGHT_RAIL)) / 2 - CLEAR_GAP - NODE_MARGIN;
  return Math.max(MIN_ORBIT, Math.min(byHeight, byWidth));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The nodes of the orbit: the first at the top, the rest evenly around. */
export function orbitNodes(count: number, w: number, h: number): { x: number; y: number; angle: number }[] {
  const n = Math.max(0, Math.min(MAX_NODES, Math.floor(count)));
  const r = orbitRadius(w, h);
  return Array.from({ length: n }, (_, i) => {
    const angle = -90 + (i * 360) / n;
    const rad = (angle * Math.PI) / 180;
    return { x: round2(w / 2 + r * Math.cos(rad)), y: round2(h / 2 + r * Math.sin(rad)), angle };
  });
}

/** The circle the orbit and its nodes occupy: nothing but the orb's own layers may be drawn inside it. */
export function centreClear(w: number, h: number): { cx: number; cy: number; r: number } {
  return { cx: w / 2, cy: h / 2, r: orbitRadius(w, h) + NODE_MARGIN };
}

export function layoutMode(w: number, _h: number): "orbit" | "compact" {
  return w <= COMPACT_MAX_WIDTH ? "compact" : "orbit";
}

/** One zone's rectangle. The rails are cut into three rows between the top bar and the bottom bar. */
export function zoneRect(zone: ZoneId, w: number, h: number): Rect {
  const topH = h * TOP_BAR;
  const bottomH = h * BOTTOM_BAR;
  if (zone === "top") return { x: ZONE_GAP, y: ZONE_GAP, width: w - 2 * ZONE_GAP, height: topH };
  if (zone === "bottom") return { x: ZONE_GAP, y: h - bottomH - ZONE_GAP, width: w - 2 * ZONE_GAP, height: bottomH };
  const railTop = ZONE_GAP + topH + ZONE_GAP;
  const railBottom = h - bottomH - 2 * ZONE_GAP;
  const rowH = (railBottom - railTop - 2 * ZONE_GAP) / 3;
  const row = zone.endsWith("top") ? 0 : zone.endsWith("mid") ? 1 : 2;
  const y = railTop + row * (rowH + ZONE_GAP);
  return zone.startsWith("left")
    ? { x: ZONE_GAP, y, width: w * LEFT_RAIL - ZONE_GAP, height: rowH }
    : { x: w * (1 - RIGHT_RAIL), y, width: w * RIGHT_RAIL - ZONE_GAP, height: rowH };
}
