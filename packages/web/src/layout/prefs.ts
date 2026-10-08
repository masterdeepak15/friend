import type { ViewPreset } from "@friend/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export type PanelId = "chat" | "tasks" | "status" | "clock";
export const PANEL_IDS: PanelId[] = ["chat", "tasks", "status", "clock"];

/** What each view shows before the owner switches anything on or off by hand. */
export const VIEW_PANELS: Record<ViewPreset, Record<PanelId, boolean>> = {
  minimal: { chat: false, tasks: false, status: false, clock: false },
  companion: { chat: false, tasks: false, status: true, clock: true },
  workspace: { chat: true, tasks: true, status: true, clock: true },
};

export const VIEWS: ViewPreset[] = ["minimal", "companion", "workspace"];

const OVERRIDES_KEY = "friend.panels";
const POS_PREFIX = "friend.pos.";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // private window, blocked storage, bad data: the defaults apply
  }
}
function write(key: string, value: unknown | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not remembered, still works */
  }
}

export interface Pos {
  x: number;
  y: number;
}
export const loadPos = (id: PanelId): Pos | null => {
  const p = read<Pos>(POS_PREFIX + id);
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.min(Math.max(p.x, 0), 95), y: Math.min(Math.max(p.y, 0), 95) } : null;
};
export const savePos = (id: PanelId, pos: Pos | null): void => write(POS_PREFIX + id, pos);
export const resetPositions = (): void => PANEL_IDS.forEach((id) => savePos(id, null));

/**
 * Which panels are showing: the chosen view decides, and the owner's own switches (menu, /chat, /tasks) are kept on top of
 * it until the view is changed again. Remembered per browser.
 */
export function usePanels(view: ViewPreset) {
  const [overrides, setOverrides] = useState<Partial<Record<PanelId, boolean>>>(() => read(OVERRIDES_KEY) ?? {});
  const lastView = useRef(view);

  useEffect(() => {
    // choosing another view starts from that view's own set of panels
    if (lastView.current === view) return;
    lastView.current = view;
    setOverrides({});
    write(OVERRIDES_KEY, null);
  }, [view]);

  const show = { ...VIEW_PANELS[view], ...overrides };
  const toggle = useCallback(
    (id: PanelId, on?: boolean) =>
      setOverrides((o) => {
        const current = { ...VIEW_PANELS[view], ...o }[id];
        const next = { ...o, [id]: on ?? !current };
        write(OVERRIDES_KEY, next);
        return next;
      }),
    [view],
  );
  return { show, toggle };
}
