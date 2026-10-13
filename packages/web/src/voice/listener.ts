import { captureSession } from "./audioSession";
import { Segmenter, type SegmenterOptions } from "./segmenter";

const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const POLL_MS = 50;
/** While nothing is being said the short recording is thrown away and restarted this often, so the start of a phrase is always inside it. */
const ROTATE_MS = 2000;
const STOP_TIMEOUT_MS = 2000;
/** Shorter than this (in total) is not worth transcribing. */
const MIN_UTTERANCE_MS = 400;

export interface ListenerOptions extends SegmenterOptions {
  /** One thing was said: the audio of it. */
  onUtterance: (audio: Blob) => void;
  /** The microphone stopped working. The listener has already released it. */
  onError: (message: string) => void;
  now?: () => number;
}

const friendly = (e: unknown): string => {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was denied. Allow it in the browser to use hands-free.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  return (e as Error)?.message || "Could not open the microphone.";
};

/**
 * Keeps the microphone open and hands over each thing said as its own short recording. It decides nothing about the words:
 * the page asks the server whether they began with the assistant's name.
 */
export class Listener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private recStartedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seg: Segmenter;
  private leaveSession: (() => void) | null = null;
  private paused = false;
  private starting = false;
  private finishing = false;
  private opened = false;
  private readonly now: () => number;

  constructor(private opts: ListenerOptions) {
    this.seg = new Segmenter(opts);
    this.now = opts.now ?? (() => Date.now());
  }

  static supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  get listening(): boolean {
    return this.opened;
  }

  async start(): Promise<void> {
    if (this.opened || this.starting) return;
    this.starting = true;
    try {
      this.leaveSession = captureSession();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        this.leaveSession?.();
        this.leaveSession = null;
        throw new Error(friendly(e));
      }
      for (const track of this.stream.getTracks()) track.onended = () => this.broke("The microphone stopped working.");
      try {
        this.ctx = new AudioContext();
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
        void this.ctx.resume().catch(() => {}); // a meter that starts suspended reads only silence
      } catch {
        this.release();
        throw new Error("This browser cannot listen continuously here.");
      }
      this.seg.reset();
      this.beginRecording();
      this.opened = true;
      this.timer = setInterval(() => this.tick(), POLL_MS);
    } finally {
      this.starting = false;
    }
  }

  /** Stops listening and releases the microphone. Whatever was being said is dropped. */
  stop(): void {
    this.opened = false;
    this.release();
  }

  /** While the page is busy (Friend is speaking, a held-key recording runs) nothing is collected. */
  pause(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    this.seg.reset();
    if (!on && this.opened) this.restartRecording();
  }

  /** Current input loudness, 0..1. */
  level(): number {
    if (!this.analyser) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }

  private tick(): void {
    if (!this.opened) return;
    const now = this.now();
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    if (this.paused) {
      if (now - this.recStartedAt >= ROTATE_MS) this.restartRecording();
      return;
    }
    const ev = this.seg.feed(this.level(), now);
    if (ev?.type === "end") void this.finish(ev.ms, ev.speechMs);
    else if (!ev && !this.seg.inSpeech && !this.seg.maybeSpeech && now - this.recStartedAt >= ROTATE_MS) this.restartRecording();
  }

  private beginRecording(): void {
    if (!this.stream) return;
    const mimeType = MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t));
    this.chunks = [];
    const rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onerror = () => this.broke("The microphone stopped working.");
    rec.start(250);
    this.rec = rec;
    this.recStartedAt = this.now();
  }

  private restartRecording(): void {
    const old = this.rec;
    this.rec = null;
    if (old) {
      old.ondataavailable = null;
      old.onstop = null;
      old.onerror = null;
      try {
        if (old.state !== "inactive") old.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.opened) this.beginRecording();
  }

  /** What was said is over: stop the short recording, hand it over, and start a fresh one at once. */
  private async finish(ms: number, speechMs: number): Promise<void> {
    const rec = this.rec;
    if (!rec || this.finishing) return;
    this.finishing = true;
    const type = rec.mimeType || "audio/webm";
    const audio = await new Promise<Blob>((resolve) => {
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        resolve(new Blob(this.chunks, { type }));
      };
      const guard = setTimeout(end, STOP_TIMEOUT_MS);
      rec.onstop = () => {
        clearTimeout(guard);
        end();
      };
      try {
        if (rec.state === "inactive") end();
        else rec.stop();
      } catch {
        end();
      }
    });
    this.finishing = false;
    this.rec = null;
    if (!this.opened) return;
    this.beginRecording();
    if (!this.paused && ms >= MIN_UTTERANCE_MS && speechMs >= MIN_UTTERANCE_MS / 2 && audio.size > 0) this.opts.onUtterance(audio);
  }

  private broke(message: string): void {
    if (!this.opened) return;
    this.stop();
    this.opts.onError(message);
  }

  private release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.rec) {
      this.rec.ondataavailable = null;
      this.rec.onstop = null;
      this.rec.onerror = null;
      try {
        if (this.rec.state !== "inactive") this.rec.stop();
      } catch {
        /* already stopped */
      }
    }
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.rec = null;
    this.chunks = [];
    this.leaveSession?.();
    this.leaveSession = null;
  }
}
