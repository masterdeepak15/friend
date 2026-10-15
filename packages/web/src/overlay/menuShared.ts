
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


const MUTED_KEY = "friend.stageMuted";

/** Whether the owner muted the stage, remembered on this device so a reload does not undo it. */
export function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveMuted(on: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, on ? "1" : "0");
  } catch {
    /* private window: the choice is just not remembered */
  }
}
const QUIET_KEY = "friend.voiceOff";

/** Whether the owner keeps the voice off on this device (read the captions and the chat instead). It is its own choice, apart from the muted stage. */
export function readQuiet(): boolean {
  try {
    return localStorage.getItem(QUIET_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveQuiet(on: boolean): void {
  try {
    localStorage.setItem(QUIET_KEY, on ? "1" : "0");
  } catch {
    /* private window: the choice is just not remembered */
  }
}