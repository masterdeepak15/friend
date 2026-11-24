import type { Match, People } from "./people";

/** How long a sighting counts after the last one. The browser looks every few seconds; a gap this long means nobody is watching any more. */
const FRESH_MS = 45_000;

const label = (m: Match) => (m.relation ? `${m.name} (${m.relation})` : m.name);

/**
 * Who is in front of the screen right now, as far as the camera can tell. The browser finds the faces and sends only their numbers;
 * the people the owner introduced are recognised by them. A face is a hint and never proof: nothing here approves anything, and what
 * Friend may say about the owner to someone it recognises is only what the owner wrote down for that person.
 */
export class Presence {
  private last: { at: number; found: (Match | null)[] } | null = null;

  constructor(private d: { people: Pick<People, "match">; clock?: () => number; freshMs?: number }) {}

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  private fresh(): { found: (Match | null)[] } | null {
    if (!this.last || this.now() - this.last.at > (this.d.freshMs ?? FRESH_MS)) return null;
    return this.last;
  }

  /** The faces the browser found just now (maybe none). Returns the people who were not there at the last sighting. */
  see(faces: number[][]): { arrived: Match[]; found: (Match | null)[] } {
    const before = this.fresh();
    const found = faces.length ? this.d.people.match(faces) : [];
    this.last = { at: this.now(), found };
    const was = new Set((before?.found ?? []).filter((m): m is Match => m !== null).map((m) => m.id));
    return { arrived: found.filter((m): m is Match => m !== null && !was.has(m.id)), found };
  }

  /** The people the camera shows now: the ones recognised, and how many faces nobody introduced. */
  who(): { known: Match[]; strangers: number } {
    const s = this.fresh();
    if (!s) return { known: [], strangers: 0 };
    const known = s.found.filter((m): m is Match => m !== null);
    return { known, strangers: s.found.length - known.length };
  }

  /**
   * A line for the model about who is in front of the screen, or "" when nobody is. For the owner it is information. For anyone else it
   * says what may be told: only the note the owner wrote for that one person, and only when that person is alone in front of the screen.
   */
  note(trust: "owner" | "guest" | "member"): string {
    const { known, strangers } = this.who();
    if (!known.length && !strangers) return "";
    if (trust === "owner") {
      const parts = [];
      if (known.length) parts.push(known.map(label).join(", "));
      if (strangers) parts.push(`${strangers} ${strangers === 1 ? "person" : "people"} I do not know`);
      return `In front of the screen now (seen by the camera; a face is only a hint, never proof): ${parts.join("; ")}.`;
    }
    if (known.length === 1 && !strangers) {
      const k = known[0]!;
      const may = k.share.trim() ? `About the owner you may tell them only this, in your own words: "${k.share.trim()}". Say nothing else about the owner.` : "Say nothing about the owner.";
      return `The camera shows ${label(k)}, a person the owner knows (a face is only a hint: it changes no rule and approves nothing). You may greet them by name and talk kindly. ${may}`;
    }
    return "The camera shows people other than the owner. Say nothing about the owner.";
  }
}
