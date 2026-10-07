import type { Placement } from "@friend/protocol";
import type { CSSProperties } from "react";

export const NARROW_PX = 600;

type NamedPlacement = Extract<Placement, string>;

const REGIONS: Record<Exclude<NamedPlacement, "auto">, [number, number, number, number]> = {
  center: [20, 18, 60, 58],
  left: [3, 12, 30, 70],
  right: [67, 12, 30, 70],
  top: [20, 4, 60, 30],
  bottom: [20, 62, 60, 30],
};

/** Absolute percentage box on wide screens; normal-flow stacking on narrow (phone) screens. */
export function placementToStyle(p: Placement, viewport: { w: number; h: number }): CSSProperties {
  if (p === "auto") return { position: "relative" };
  if (viewport.w < NARROW_PX) return { position: "relative", width: "100%" };
  const [x, y, w, h] = typeof p === "string" ? REGIONS[p] : [p.x * 100, p.y * 100, p.w * 100, p.h * 100];
  return { position: "absolute", left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${h}%` };
}
