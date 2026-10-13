export interface SegmenterOptions {
  /** Loud this long without a break before it counts as speech (shorter sounds are clicks and coughs). */
  minSpeechMs?: number;
  /** Quiet this long ends what was being said. */
  endSilenceMs?: number;
  /** The longest single utterance. */
  maxMs?: number;
}

export type SegmentEvent = { type: "start" } | { type: "end"; ms: number; speechMs: number; forced: boolean };

/** Speech counts when the level is this many times the room's usual level (plus a little, so a dead-quiet room still works). */
const MARGIN = 2.2;
const SLACK = 0.012;
const MIN_THRESHOLD = 0.02;

/**
 * Cuts a stream of loudness readings into utterances. Pure: give it the level and the time, it says when speech starts and ends.
 * The room's usual loudness is learned while nobody speaks, so a fan or a far-away voice both work.
 */
export class Segmenter {
  private readonly minSpeechMs: number;
  private readonly endSilenceMs: number;
  private readonly maxMs: number;
  private floor: number | null = null;
  private loudSince: number | null = null;
  private speaking = false;
  private startedAt = 0;
  private lastLoud = 0;
  private lastFeed = 0;
  private speechMs = 0;

  constructor(opts: SegmenterOptions = {}) {
    this.minSpeechMs = opts.minSpeechMs ?? 250;
    this.endSilenceMs = opts.endSilenceMs ?? 800;
    this.maxMs = opts.maxMs ?? 8000;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** Something loud is happening that has not yet lasted long enough to be speech. */
  get maybeSpeech(): boolean {
    return this.loudSince !== null;
  }

  feed(level: number, now: number): SegmentEvent | null {
    if (this.floor === null) this.floor = level;
    const loud = level > Math.max(this.floor * MARGIN + SLACK, MIN_THRESHOLD);
    const dt = Math.min(100, Math.max(0, now - this.lastFeed));
    this.lastFeed = now;
    if (!this.speaking) {
      if (!loud) {
        this.loudSince = null;
        this.floor += (level - this.floor) * (level < this.floor ? 0.3 : 0.02); // down fast, up slowly
        return null;
      }
      this.loudSince ??= now;
      if (now - this.loudSince < this.minSpeechMs) return null;
      this.speaking = true;
      this.startedAt = this.loudSince;
      this.lastLoud = now;
      this.speechMs = now - this.loudSince;
      return { type: "start" };
    }
    if (loud) {
      this.lastLoud = now;
      this.speechMs += dt;
    }
    const forced = now - this.startedAt >= this.maxMs;
    if (!forced && now - this.lastLoud < this.endSilenceMs) return null;
    const ev: SegmentEvent = { type: "end", ms: now - this.startedAt, speechMs: this.speechMs, forced };
    this.speaking = false;
    this.loudSince = null;
    if (forced && loud) this.floor = level; // it never went quiet: that is the room's new usual sound, not a person
    return ev;
  }

  /** Forget what is being said (the owner is being spoken to, or the page was busy); keep what was learned about the room. */
  reset(): void {
    this.speaking = false;
    this.loudSince = null;
  }
}
