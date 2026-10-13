
/** Minimal hides the status line and the clock, so it is only chosen on purpose (Settings, /view minimal), never by cycling. */
export const NEXT_VIEW = { minimal: "companion", companion: "workspace", workspace: "companion" } as const;

export type MenuStyle = "orb" | "classic";
const KEY = "friend.menuStyle";

/** The owner's choice of menu, remembered on this device only. The orb is the default. */
export function readMenuStyle(): MenuStyle {
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "orb";
  } catch {
    return "orb";
  }
}

export function saveMenuStyle(style: MenuStyle): void {
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* private window: the choice is just not remembered */
  }
}

