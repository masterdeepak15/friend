/** The plain-code part of a meeting: no browser and no model in here. */

export interface CaptionItem {
  speaker: string;
  text: string;
}

export interface Line {
  speaker: string;
  text: string;
  /** Set only by the voice engine when the voice matched the owner's voiceprint: a name in a caption can be chosen by anyone, this cannot. */
  verified?: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Turns what the caption panel shows from moment to moment into finished lines. Teams grows a caption word by word and keeps the
 * last few on screen, so the same words arrive again and again: a line is finished when something newer appears after it, when it
 * stops changing for `settleMs`, or when it leaves the screen. If a speaker carries on in the same bubble after a pause, only the new
 * words come out.
 */
export class CaptionTracker {
  private open: { speaker: string; text: string; changedAt: number; done: boolean }[] = [];
  private said = new Map<string, string>();

  constructor(private settleMs = 2500) {}

  feed(items: CaptionItem[], now: number): Line[] {
    const cur = items.map((i) => ({ speaker: norm(i.speaker) || "Someone", text: norm(i.text) })).filter((i) => i.text);
    const out: Line[] = [];
    const used = new Set<number>();
    const next = cur.map((c) => {
      for (let k = 0; k < this.open.length; k++) {
        const o = this.open[k]!;
        if (used.has(k) || o.speaker !== c.speaker) continue;
        if (c.text.startsWith(o.text) || o.text.startsWith(c.text)) {
          used.add(k);
          const same = c.text === o.text;
          return { ...c, changedAt: same ? o.changedAt : now, done: same && o.done };
        }
      }
      return { ...c, changedAt: now, done: false };
    });
    // what was on screen and is gone is finished
    this.open.forEach((o, k) => {
      if (!used.has(k) && !o.done) this.finish(o, out);
    });
    // everything but the newest caption is finished, and so is the newest one when it stopped changing
    next.forEach((n, k) => {
      if (n.done) return;
      if (k < next.length - 1 || now - n.changedAt >= this.settleMs) {
        this.finish(n, out);
        n.done = true;
      }
    });
    this.open = next;
    return out;
  }

  /** The caption still being spoken, if any (the end of the meeting says it too). */
  flush(): Line[] {
    const out: Line[] = [];
    for (const o of this.open) if (!o.done) this.finish(o, out);
    this.open = [];
    return out;
  }

  private finish(o: { speaker: string; text: string }, out: Line[]): void {
    const before = this.said.get(o.speaker);
    if (before === o.text) return;
    this.said.set(o.speaker, o.text);
    if (before && o.text.startsWith(before)) {
      const rest = norm(o.text.slice(before.length));
      if (rest) out.push({ speaker: o.speaker, text: rest });
      return;
    }
    out.push({ speaker: o.speaker, text: o.text });
  }
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when one of the names is spoken as a word (not inside another word). */
export function mentions(text: string, names: readonly string[]): boolean {
  for (const n of names) {
    const name = n.trim();
    if (name.length < 2) continue;
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "iu").test(text)) return true;
  }
  return false;
}

/** Whether a line is the assistant being called: one of its names, said by somebody other than itself. */
export function isAddressed(line: Line, names: readonly string[], selfName: string, fuzzy = false): boolean {
  if (line.speaker.trim().toLowerCase() === selfName.trim().toLowerCase()) return false;
  return mentions(line.text, names) || (fuzzy && soundsLike(line.text, names));
}

const within1 = (a: string, b: string): boolean => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return true;
  const rest = (s: string, from: number) => s.slice(from);
  return rest(a, i + 1) === rest(b, i + 1) || rest(a, i + 1) === rest(b, i) || rest(a, i) === rest(b, i + 1);
};

/**
 * For speech read by a speech engine, which often garbles a name ("Umayyad" for "Maya"): a spoken word that is one letter off a name, or that has a
 * one-letter-off copy of the name inside it. Names under four letters are never matched this way: too many ordinary words are close to them.
 */
export function soundsLike(text: string, names: readonly string[]): boolean {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  for (const n of names) {
    const name = n.trim().toLowerCase();
    if (name.length < 4 || /\s/.test(name)) continue;
    for (const w of words) {
      if (w.length < name.length) continue; // a shorter word (\"May\" for \"Maya\") is far more likely a real word
      if (within1(w, name)) return true;
      // a name with something run into the front of it (\"Umayyad\"); not one that merely starts a longer word (\"maybe\", \"mayor\")
      for (let i = 1; i + name.length <= w.length; i++) if (within1(w.slice(i, i + name.length), name)) return true;
    }
  }
  return false;
}

/** Whether a line concerns the owner: their name, or a topic they asked to hear about. The owner's own lines never do. */
export function concernsOwner(line: Line, ownerNames: readonly string[], keywords: readonly string[]): boolean {
  if (mentions(line.speaker, ownerNames)) return false;
  return mentions(line.text, ownerNames) || mentions(line.text, keywords);
}

/** Is the speaker the owner (a caption's author name matches one of the owner's names)? */
export function isOwnerSpeaking(speaker: string, ownerNames: readonly string[]): boolean {
  return mentions(speaker, ownerNames);
}

const HOSTS = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);

/** The first Teams meeting link in a text, cleaned up, or null. Only Teams addresses are ever opened. */
export function findTeamsLink(text: string): string | null {
  const m = /https:\/\/(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)\/[^\s<>"')\]]+/i.exec(text);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?]+$/, "");
  return isTeamsMeetingUrl(url) ? url : null;
}

export function isTeamsMeetingUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOSTS.has(u.hostname.toLowerCase())) return false;
  return /^\/(l\/meetup-join\/|meet\/|v2\/|l\/meeting\/)/i.test(u.pathname) || /^\/(l\/meetup-join|meet)\b/i.test(u.pathname);
}

/** Spaces out what a person may be told: the same kind of suggestion no more than once a minute, a call by name one at a time. */
export class Cooldown {
  private last = new Map<string, number>();
  constructor(private ms: number) {}
  take(key: string, now: number): boolean {
    const was = this.last.get(key);
    if (was !== undefined && now - was < this.ms) return false;
    this.last.set(key, now);
    return true;
  }
}

export type Platform = "teams" | "meet" | "zoom";

const plain = (u: URL) => u.protocol === "https:" && !u.username && !u.password && !u.port;

/** Which meeting site an address is, or null when it is not a meeting link of one of them. Only these are ever opened. */
export function meetingPlatform(url: string): Platform | null {
  if (isTeamsMeetingUrl(url)) return "teams";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!plain(u)) return null;
  const host = u.hostname.toLowerCase();
  if (host === "meet.google.com" && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(u.pathname)) return "meet";
  if ((host === "zoom.us" || host.endsWith(".zoom.us") || host === "zoom.com" || host.endsWith(".zoom.com")) && /^\/(j|wc\/join)\/\d{8,12}\/?$/.test(u.pathname)) return "zoom";
  return null;
}

export const isMeetingUrl = (url: string): boolean => meetingPlatform(url) !== null;

/** Zoom's own page asks to open the app; the browser version is the same meeting at /wc/join. */
export function normalizeMeetingUrl(url: string): string {
  if (meetingPlatform(url) !== "zoom") return url;
  const u = new URL(url);
  u.pathname = u.pathname.replace(/^\/j\//, "/wc/join/");
  return u.toString();
}

/** The first meeting link of any supported site in a text, or null. */
export function findMeetingLink(text: string): string | null {
  for (const m of text.matchAll(/https:\/\/[^\s<>"')\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (isMeetingUrl(url)) return url;
  }
  return null;
}