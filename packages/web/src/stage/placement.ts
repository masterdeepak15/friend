import { REGIONS, type Placement } from "@friend/protocol";
import type { CSSProperties } from "react";

export const NARROW_PX = 600;


/** Absolute percentage box on wide screens; normal-flow stacking on narrow (phone) screens. */
export function placementToStyle(p: Placement, viewport: { w: number; h: number }): CSSProperties {
  if (p === "auto") return { position: "relative" };
  if (viewport.w < NARROW_PX) return { position: "relative", width: "100%" };
  const [x, y, w, h] = typeof p === "string" ? REGIONS[p] : [p.x * 100, p.y * 100, p.w * 100, p.h * 100];
  const box = { position: "absolute", left: `${x}%`, top: `${y}%`, width: `${w}%` } as const;
  // banner-like regions hug their content; tall regions and explicit boxes keep their full height
  if (p === "top" || p === "bottom") return { ...box, maxHeight: `${h}%` };
  return { ...box, height: `${h}%` };
}
