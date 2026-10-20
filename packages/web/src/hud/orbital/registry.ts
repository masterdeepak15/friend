import { HUD_WIDGET_IDS, type HudDensity, type HudWidgetId } from "@friend/protocol";
import type { ZoneId } from "./geometry";

export interface WidgetDef {
  id: HudWidgetId;
  title: string;
  zone: ZoneId | "centre";
  /** orange is for "needs the owner" only. */
  tone: "cyan" | "green" | "orange";
  /** The least dense setting that shows this widget without the owner switching it on. */
  minDensity: HudDensity;
}

/** Every instrument of the orbital screen, placed as in the approved mockup. */
export const WIDGETS: readonly WidgetDef[] = [
  { id: "system", title: "System", zone: "left-top", tone: "cyan", minDensity: "standard" },
  { id: "voice", title: "Voice", zone: "left-mid", tone: "cyan", minDensity: "standard" },
  { id: "network", title: "Network", zone: "left-mid", tone: "cyan", minDensity: "full" },
  { id: "feed", title: "Activity", zone: "left-bottom", tone: "green", minDensity: "standard" },
  { id: "radar", title: "Devices", zone: "right-top", tone: "cyan", minDensity: "full" },
  { id: "tickets", title: "Tickets", zone: "right-mid", tone: "green", minDensity: "full" },
  { id: "budget", title: "Budget", zone: "right-mid", tone: "cyan", minDensity: "full" },
  { id: "approval", title: "Approvals", zone: "right-bottom", tone: "orange", minDensity: "standard" },
  { id: "usage", title: "Usage", zone: "centre", tone: "cyan", minDensity: "calm" },
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
