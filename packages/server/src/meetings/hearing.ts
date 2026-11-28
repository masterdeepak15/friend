import type { Line } from "./logic";

/** Turns 16 kHz 16-bit mono sound into the words in it. */
export type Transcriber = (pcm: Buffer) => Promise<string | { text: string; /** Who it sounded like, when the voice could be recognised. */ speaker?: string; /** The voice matched the owner's voiceprint. */ verified?: boolean }>;

const RATE = 16000;
const FRAME = RATE / 10; // 100 ms
const rms = (pcm: Buffer, from: number, to: number): number => {
  let sum = 0;
  let n = 0;
  for (let i = from; i + 1 < to; i += 2) {
    const v = pcm.readInt16LE(i) / 32768;
    sum += v * v;
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
};

/** What a speech model writes for silence or noise, and what is not speech at all. */
export function cleanTranscript(raw: string): string {
  const t = raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return "";
  if (/^(thanks for watching|thank you for watching|please subscribe|you|bye|thank you|thanks|you'?re welcome|okay|ok)[.!]?$/i.test(t)) return "";
  // what a model that learned from videos writes when it is given silence
  if (/(for watching|like,? (share|comment)|subscribe|subtitles by|amara\.org|see you (in the )?next)/i.test(t)) return "";
  // the same word over and over is what a speech engine makes of noise
  const words = t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.length >= 4 && new Set(words).size <= Math.ceil(words.length / 4)) return "";
  return t;
}

export interface HearingOptions {
  transcribe: Transcriber;
  /** What the speakers are called when the sound alone cannot tell. */
  speaker?: string;
  /** Sound quieter than this (0-1) is silence. */
  silence?: number;
  /** Shortest and longest stretch sent to the model at once, in seconds. */
  minSeconds?: number;
  maxSeconds?: number;
}

/**
 * Hears the meeting when it has no live captions: the sound of the call arrives a little at a time, is cut into stretches at the pauses
 * between sentences, and each stretch that has speech in it is turned into words by a speech model that runs on this PC. The sound itself
 * is never kept. It cannot tell the speakers apart, so every line is from "Someone".
 */
export class AudioHearing {
  private buf = Buffer.alloc(0);
  private queue: Buffer[] = [];
  private busy = false;
  private ready: Line[] = [];
  private o: Required<Omit<HearingOptions, "transcribe">> & { transcribe: Transcriber };

  constructor(o: HearingOptions) {
    this.o = { speaker: "Someone", silence: 0.012, minSeconds: 0.9, maxSeconds: 10, ...o };
  }

  /** When someone was last heard talking (milliseconds, Date.now): it never starts to speak over them. */
  lastVoiceAt = 0;
  private floor = 0.004;

  push(pcm: Buffer): void {
    if (!pcm.length) return;
    // every 100 ms: is this somebody talking, against the background noise of the room that is learned as it goes
    for (let i = 0; i + FRAME * 2 <= pcm.length; i += FRAME * 2) {
      const e = rms(pcm, i, i + FRAME * 2);
      this.floor = e < this.floor ? e * 0.5 + this.floor * 0.5 : this.floor * 0.995 + e * 0.005;
      if (e >= Math.max(this.o.silence, this.floor * 3)) this.lastVoiceAt = Date.now();
    }
    this.buf = Buffer.concat([this.buf, pcm]);
    const seconds = this.buf.length / 2 / RATE;
    if (seconds < this.o.minSeconds) return;
    const tail = rms(this.buf, Math.max(0, this.buf.length - FRAME * 2 * 5), this.buf.length);
    if (tail < this.o.silence || seconds >= this.o.maxSeconds) this.cut();
  }

  /** The lines the model has finished since the last call. */
  take(): Line[] {
    const r = this.ready;
    this.ready = [];
    return r;
  }

  /** Sends what is left (the meeting ended). */
  async finish(): Promise<void> {
    this.cut();
    while (this.busy || this.queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  private cut(): void {
    const chunk = this.buf;
    this.buf = Buffer.alloc(0);
    // a stretch with hardly any speech in it is not sent: that is where a model makes things up
    const energy: number[] = [];
    for (let i = 0; i + FRAME * 2 <= chunk.length; i += FRAME * 2) energy.push(rms(chunk, i, i + FRAME * 2));
    if (energy.length < 8) return;
    // speech has to stand out from the room: well above its background noise, which is learned from the quiet moments over the whole call
    const bar = Math.max(this.o.silence, this.floor * 3);
    const voiced = energy.filter((e) => e >= bar).length;
    if (voiced / energy.length < 0.12) return;
    this.queue.push(chunk);
    if (this.queue.length > 3) this.queue.shift(); // the model is behind: the oldest is dropped rather than everything running late
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let c = this.queue.shift(); c; c = this.queue.shift()) {
        const heard = await this.o.transcribe(c).catch(() => "");
        const text = cleanTranscript(typeof heard === "string" ? heard : heard.text);
        if (text) this.ready.push({ speaker: (typeof heard === "object" && heard.speaker) || this.o.speaker, text, ...(typeof heard === "object" && heard.verified ? { verified: true } : {}) });
      }
    } finally {
      this.busy = false;
    }
  }
}
