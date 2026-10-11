/** What the music player and the screen widgets may be set to. Shared so the server and the settings screen use the same rules. */

/** The audio kinds a browser can play. The owner picks which of them to look for. */
export const AUDIO_EXTENSIONS = ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"] as const;

export const MUSIC_LIMITS = {
  maxTracks: { min: 100, max: 50_000, def: 5000 },
  scanDepth: { min: 1, max: 12, def: 6 },
  volume: { min: 0, max: 100, def: 70 },
} as const;

/** What a quick-launch button can do. */
export const LAUNCHER_PANELS = ["chat", "tasks", "plugins", "settings", "music"] as const;
export const LAUNCHER_MUSIC = ["toggle", "play", "pause", "next", "previous"] as const;
export const LAUNCHER_ACTIONS = ["url", "prompt", "panel", "music"] as const;
export const MAX_LAUNCHER = 12;

export interface LauncherItem {
  id: string;
  label: string;
  icon: string;
  action: { type: (typeof LAUNCHER_ACTIONS)[number]; value: string };
}

/** Why a quick-launch button cannot be used, or null when it can. An address must be http or https: nothing that runs code or opens a file. */
export function launcherProblem(raw: unknown): string | null {
  const r = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!r) return "A button needs a label and an action.";
  const label = typeof r.label === "string" ? r.label.trim() : "";
  if (label.length < 1 || label.length > 24) return "A button label is 1 to 24 characters.";
  const icon = typeof r.icon === "string" ? r.icon.trim() : "";
  if (icon.length < 1 || [...icon].length > 4) return "A button icon is 1 to 4 characters (a symbol or an emoji).";
  const a = (r.action && typeof r.action === "object" ? r.action : null) as Record<string, unknown> | null;
  if (!a || !(LAUNCHER_ACTIONS as readonly unknown[]).includes(a.type) || typeof a.value !== "string") return "A button needs an action: an address, a question, a panel or a music control.";
  const value = a.value.trim();
  switch (a.type) {
    case "url": {
      if (value.length > 500) return "A button address is at most 500 characters.";
      try {
        const u = new URL(value);
        return u.protocol === "https:" || u.protocol === "http:" ? null : "A button address must start with https:// or http://.";
      } catch {
        return "A button address must start with https:// or http://.";
      }
    }
    case "prompt":
      return value.length >= 1 && value.length <= 500 ? null : "A question for the assistant is 1 to 500 characters.";
    case "panel":
      return (LAUNCHER_PANELS as readonly string[]).includes(value) ? null : `A panel is one of: ${LAUNCHER_PANELS.join(", ")}.`;
    default:
      return (LAUNCHER_MUSIC as readonly string[]).includes(value) ? null : `A music control is one of: ${LAUNCHER_MUSIC.join(", ")}.`;
  }
}

export type RepeatMode = "off" | "all" | "one";
export const REPEAT_MODES: readonly RepeatMode[] = ["off", "all", "one"];
