export interface AudioChunk {
  id: string;
  seq: number;
  last: boolean;
  mime: string;
  data: string;
}

interface Pending {
  parts: Map<number, Uint8Array>;
  lastSeq: number | null;
  bytes: number;
}

/** Limits that keep a buggy or hostile server from growing the browser's memory without bound. */
const MAX_SEQ = 4096;
const MAX_PENDING_CLIPS = 8;
const MAX_QUEUED_CLIPS = 20;
const MAX_CLIP_BYTES = 6_000_000;

function fromBase64(data: string): Uint8Array | null {
  try {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Reassembles audio chunks from the gateway and plays the clips in order, exposing the output level. */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private pending = new Map<string, Pending>();
  private queue: ArrayBuffer[] = [];
  private current: AudioBufferSourceNode | null = null;
  private busy = false;
  private gen = 0;
  private isPlaying = false;
  private listeners = new Set<(playing: boolean) => void>();

  /** Create/resume the audio context. Call it from a user gesture (a key press) so playback is allowed. */
  unlock(): void {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  }

  /** True while the browser is still blocking sound (nothing has been clicked or pressed on the page yet). */
  locked(): boolean {
    return !this.ctx || this.ctx.state !== "running";
  }

  enqueue(chunk: AudioChunk): void {
    if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || chunk.seq > MAX_SEQ) return;
    const bytes = fromBase64(chunk.data);
    if (!bytes) return;

    let p = this.pending.get(chunk.id);
    if (!p) {
      if (this.pending.size >= MAX_PENDING_CLIPS) this.pending.delete(this.pending.keys().next().value!); // drop the oldest
      p = { parts: new Map(), lastSeq: null, bytes: 0 };
      this.pending.set(chunk.id, p);
    }
    p.bytes += bytes.length;
    if (p.bytes > MAX_CLIP_BYTES) {
      this.pending.delete(chunk.id);
      return;
    }
    p.parts.set(chunk.seq, bytes);
    if (chunk.last) p.lastSeq = chunk.seq;
    if (p.lastSeq === null || p.parts.size !== p.lastSeq + 1) return;

    this.pending.delete(chunk.id);
    const joined = new Uint8Array([...p.parts.values()].reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (let i = 0; i <= p.lastSeq; i++) {
      const part = p.parts.get(i);
      if (!part) return; // a gap: the clip can never be completed
      joined.set(part, at);
      at += part.length;
    }
    this.queue.push(joined.buffer);
    while (this.queue.length > MAX_QUEUED_CLIPS) this.queue.shift();
    void this.pump();
  }

  /** Stops the current clip and forgets everything queued or half received. */
  stop(): void {
    this.gen++;
    this.queue = [];
    this.pending.clear();
    this.busy = false;
    const src = this.current;
    this.current = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already finished */
      }
    }
    this.setPlaying(false);
  }

  /** Stops playback and releases the audio context (the browser limits how many can exist). */
  dispose(): void {
    this.stop();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
  }

  playing(): boolean {
    return this.isPlaying;
  }

  onChange(cb: (playing: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Output loudness, 0..1. */
  level(): number {
    if (!this.analyser || !this.isPlaying) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  private setPlaying(v: boolean): void {
    if (this.isPlaying === v) return;
    this.isPlaying = v;
    this.listeners.forEach((cb) => cb(v));
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) {
      this.setPlaying(false);
      return;
    }
    this.busy = true;
    const gen = this.gen;
    try {
      const ctx = this.ensureContext();
      if (ctx.state === "suspended") {
        // the browser has not allowed audio yet (no user gesture): do not pretend to be playing
        try {
          await ctx.resume();
        } catch {
          /* still blocked */
        }
        if (gen !== this.gen) return;
        if ((ctx as AudioContext).state !== "running") {
          this.queue.unshift(next);
          this.busy = false;
          return;
        }
      }
      const audio = await ctx.decodeAudioData(next);
      if (gen !== this.gen) return; // stopped while decoding
      const src = ctx.createBufferSource();
      src.buffer = audio;
      src.connect(this.analyser!);
      src.onended = () => {
        if (this.current !== src) return;
        this.current = null;
        this.busy = false;
        void this.pump();
      };
      this.current = src;
      this.setPlaying(true);
      src.start();
    } catch {
      if (gen !== this.gen) return;
      this.busy = false; // skip a clip that cannot be decoded
      void this.pump();
    }
  }
}
