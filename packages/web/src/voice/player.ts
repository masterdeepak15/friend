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
}

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

  enqueue(chunk: AudioChunk): void {
    const bytes = fromBase64(chunk.data);
    if (!bytes) return;
    const p = this.pending.get(chunk.id) ?? { parts: new Map<number, Uint8Array>(), lastSeq: null };
    p.parts.set(chunk.seq, bytes);
    if (chunk.last) p.lastSeq = chunk.seq;
    this.pending.set(chunk.id, p);
    if (p.lastSeq === null || p.parts.size !== p.lastSeq + 1) return;

    this.pending.delete(chunk.id);
    const total = [...p.parts.values()].reduce((n, b) => n + b.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i <= p.lastSeq; i++) {
      const part = p.parts.get(i);
      if (!part) return; // a gap: the clip can never be completed
      joined.set(part, at);
      at += part.length;
    }
    this.queue.push(joined.buffer);
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
