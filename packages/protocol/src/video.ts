/** Where a web video is shown: the Friend screen (a browser, also a phone), or a window on the PC (mpv). The same words as the music player. */
export const VIDEO_OUTPUTS = ["screen", "host"] as const;
export type VideoOutput = (typeof VIDEO_OUTPUTS)[number];

export const VIDEO_LIMITS = {
  /** The tallest picture asked for, in pixels (a lower one saves the connection and the PC). */
  maxHeight: { min: 240, max: 1080, def: 720 },
  /** A video longer than this is not played, in minutes. */
  maxMinutes: { min: 1, max: 600, def: 240 },
  sites: { max: 50 },
} as const;

/** A site name such as youtube.com: letters, digits and hyphens in dot-separated parts, at least two parts. */
export const SITE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The owner's list of allowed sites, cleaned: lower case, a pasted address reduced to its site name, nothing that is not a site name, no repeats, at most the limit. */
export function normalizeSites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    let s = typeof v === "string" ? v.trim().toLowerCase() : "";
    if (/^https?:\/\//.test(s)) {
      try {
        s = new URL(s).hostname;
      } catch {
        s = "";
      }
    }
    if (SITE_NAME.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= VIDEO_LIMITS.sites.max) break;
  }
  return out;
}
