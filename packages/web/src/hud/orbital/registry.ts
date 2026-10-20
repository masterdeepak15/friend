import { HUD_WIDGET_IDS, type HudDensity, type HudWidgetId } from "@friend/protocol";
import type { Anchor, Box } from "./geometry";

export interface WidgetDef {
  id: HudWidgetId;
  title: string;
  /** Where it sits on the 1600 x 900 canvas of the approved mockup, and which edge it keeps to. */
  anchor: Anchor;
  box: Box;
  /** orange is for "needs the owner" only. */
  tone: "cyan" | "green" | "orange";
  /** The least dense setting that shows this widget without the owner switching it on. */
  minDensity: HudDensity;
}

/** Every instrument of the orbital screen, placed as in the approved mockup. */
export const WIDGETS: readonly WidgetDef[] = [
  { id: "system", title: "System", anchor: "left", box: { x: 40, y: 70, w: 300, h: 220 }, tone: "cyan", minDensity: "standard" },
  { id: "voice", title: "Voice", anchor: "left", box: { x: 40, y: 310, w: 300, h: 150 }, tone: "cyan", minDensity: "standard" },
  { id: "network", title: "Network", anchor: "left", box: { x: 40, y: 480, w: 300, h: 110 }, tone: "cyan", minDensity: "standard" },
  { id: "feed", title: "Activity", anchor: "left", box: { x: 40, y: 650, w: 430, h: 210 }, tone: "green", minDensity: "standard" },
  { id: "radar", title: "Devices", anchor: "right", box: { x: 1310, y: 60, w: 250, h: 270 }, tone: "cyan", minDensity: "standard" },
  { id: "tickets", title: "Tickets", anchor: "right", box: { x: 1300, y: 320, w: 270, h: 160 }, tone: "green", minDensity: "standard" },
  { id: "budget", title: "Budget", anchor: "right", box: { x: 1300, y: 480, w: 270, h: 110 }, tone: "cyan", minDensity: "standard" },
  { id: "approval", title: "Approvals", anchor: "right", box: { x: 1180, y: 650, w: 380, h: 210 }, tone: "orange", minDensity: "standard" },
  { id: "usage", title: "Usage", anchor: "centre", box: { x: 700, y: 215, w: 200, h: 30 }, tone: "cyan", minDensity: "calm" },
] satisfies readonly WidgetDef[];
if (WIDGETS.length !== HUD_WIDGET_IDS.length) throw new Error("the widget registry and HUD_WIDGET_IDS differ");

const RANK: Record<HudDensity, number> = { calm: 0, standard: 1, full: 2 };

/**
 * Which instruments to draw. The density decides, the owner's switches override it either way, and an approval that is waiting is
 * always shown (it can never be hidden). With nothing waiting, the approval frame is a dim "none waiting" one.
 */
export function visibleWidgets(density: HudDensity, widgets: Partial<Record<HudWidgetId, boolean>>, _mode: "orbit" | "compact", approvalPending: boolean): WidgetDef[] {
  return WIDGETS.filter((w) => {
    if (w.id === "approval" && approvalPending) return true;
    const choice = widgets[w.id];
    if (choice === false) return false;
    if (choice === true) return true;
    return RANK[density] >= RANK[w.minDensity];
  });
}
