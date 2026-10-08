/**
 * Claude Code reports a plan usage limit as an ordinary assistant text block ("You've hit your weekly limit · resets
 * 2:30pm (Asia/Calcutta)"), not as an error. These helpers tell that apart from a real failure and work out how long
 * to wait. (The same approach as the TeamHub runner.)
 */
const LIMIT = /\b(?:hit|reached)\s+(?:your\s+|the\s+)?(?:[\w-]+\s+)?(?:usage\s+)?limit\b|\busage\s+limit\b|\b(?:\d+-hour|weekly|daily|monthly)\s+limit\s+reached\b|\bhit your (?:weekly|daily|monthly|usage|\d+-hour) limit\b/i;

const DEFAULT_BACKOFF_MS = 15 * 60_000;
const MIN_BACKOFF_MS = 30_000;
const DAY_MS = 86_400_000;

export function isUsageLimit(text: string): boolean {
  return LIMIT.test(text);
}

/** "resets 2:30pm (Asia/Calcutta)" as a number of milliseconds from now, or undefined when it cannot be read. */
export function parseResetDelayMs(message: string, now: Date = new Date()): number | undefined {
  const m = /resets?\s+(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)/i.exec(message);
  if (!m) return undefined;
  const [, h, min, ampm, zone] = m;
  let hour = Number(h) % 12;
  if (ampm!.toLowerCase() === "pm") hour += 12;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const zoneNow = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    const offset = zoneNow - now.getTime();
    let reset = Date.UTC(get("year"), get("month") - 1, get("day"), hour, Number(min), 0) - offset;
    if (reset <= now.getTime()) reset += DAY_MS;
    const delay = reset - now.getTime();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  } catch {
    return undefined; // not a time zone this system knows
  }
}

/** How long to wait when the text is a usage-limit notice; undefined for any other failure. */
export function usageLimitBackoffMs(text: string, now: Date = new Date()): number | undefined {
  if (!isUsageLimit(text)) return undefined;
  return Math.max(parseResetDelayMs(text, now) ?? DEFAULT_BACKOFF_MS, MIN_BACKOFF_MS);
}
