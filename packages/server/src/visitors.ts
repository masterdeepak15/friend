import { FACE_SIMILARITY_THRESHOLD } from "@friend/protocol";
import { cosine, type Match } from "./people";

const MINUTE = 60_000;

export interface PendingVisitor {
  /** The 128 numbers of the stranger's face, kept in memory only until the owner answers. Never written to disk. */
  embedding: number[];
  at: number;
}

/**
 * Notices a person nobody introduced who stays in front of the screen while the owner is away, and asks the owner about them on the phone.
 * It keeps the face numbers only in memory, only until the owner answers (or half an hour), and it asks about one person at a time, rarely.
 * It never decides who the person is: only the owner's answer turns the numbers into a person Friend knows.
 */
export class Visitors {
  private cand: { embedding: number[]; n: number } | null = null;
  private pend: PendingVisitor | null = null;
  private ignored: { embedding: number[]; until: number }[] = [];
  private lastAsk = -Infinity;
  private ownerAt = -Infinity;
  private day = { key: "", n: 0 };

  constructor(
    private d: {
      enabled: () => boolean;
      /** Sends the photo and the question to the owner's phone. Resolves to whether it went. */
      ask: (embedding: number[]) => Promise<boolean>;
      clock?: () => number;
      /** In a row, the same stranger must be seen this many times (a few seconds apart) before anyone is asked. */
      sightings?: number;
      /** Nothing is asked while the owner did something at the screen in the last minutes: the stranger may be the owner. */
      ownerQuietMinutes?: number;
      cooldownMinutes?: number;
      maxPerDay?: number;
      pendingMinutes?: number;
      ignoreMinutes?: number;
    },
  ) {}

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  /** The owner is at the screen (typing, talking, clicking). */
  ownerActive(): void {
    this.ownerAt = this.now();
  }

  /** One sighting: the faces found and who each was (null: nobody introduced). Never throws. */
  see(faces: number[][], found: (Match | null)[]): void {
    try {
      const now = this.now();
      if (!this.d.enabled()) return void (this.cand = null);
      this.pending(); // lets an old question lapse
      if (this.pend) return;
      if (now - this.ownerAt < (this.d.ownerQuietMinutes ?? 10) * MINUTE) return void (this.cand = null);
      const strangers = faces.filter((_, i) => !found[i]);
      // only one stranger and nobody known: with more people in view it is not clear who is who
      if (strangers.length !== 1 || found.some(Boolean)) return void (this.cand = null);
      const e = strangers[0]!;
      this.ignored = this.ignored.filter((i) => i.until > now);
      if (this.ignored.some((i) => cosine(i.embedding, e) >= FACE_SIMILARITY_THRESHOLD)) return void (this.cand = null);
      this.cand = this.cand && cosine(this.cand.embedding, e) >= FACE_SIMILARITY_THRESHOLD ? { embedding: this.cand.embedding, n: this.cand.n + 1 } : { embedding: e, n: 1 };
      if (this.cand.n < (this.d.sightings ?? 3)) return;
      if (now - this.lastAsk < (this.d.cooldownMinutes ?? 30) * MINUTE) return;
      const key = new Date(now).toISOString().slice(0, 10);
      if (this.day.key !== key) this.day = { key, n: 0 };
      if (this.day.n >= (this.d.maxPerDay ?? 6)) return;
      this.day.n++;
      this.lastAsk = now;
      const embedding = this.cand.embedding;
      this.cand = null;
      this.pend = { embedding, at: now };
      void this.d
        .ask(embedding)
        .then((ok) => {
          if (!ok && this.pend?.embedding === embedding) this.pend = null;
        })
        .catch(() => {
          if (this.pend?.embedding === embedding) this.pend = null;
        });
    } catch {
      /* watching must never break the screen */
    }
  }

  /** The person waiting for the owner's answer, if the question is still open. */
  pending(): PendingVisitor | null {
    if (this.pend && this.now() - this.pend.at > (this.d.pendingMinutes ?? 30) * MINUTE) this.pend = null;
    return this.pend;
  }

  /** The owner answered. "stranger" also stops Friend asking about this face again for a while. Returns what was waiting. */
  resolve(kind: "known" | "stranger"): PendingVisitor | null {
    const p = this.pending();
    if (!p) return null;
    this.pend = null;
    if (kind === "stranger") this.ignored.push({ embedding: p.embedding, until: this.now() + (this.d.ignoreMinutes ?? 60) * MINUTE });
    return p;
  }

  /** For the owner's turn: that a question about a stranger is open on the phone. */
  line(): string {
    return this.pending()
      ? "A photo of a person I do not know was sent to the owner's phone and I am waiting for their answer. If the owner now says who that person is (with how they are related and what they may be told about the owner) or that they do not know them, call people.answer."
      : "";
  }
}
