import { captureSession } from "./audioSession";

const MIME_PREFERENCE = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
/** If the browser never reports the recorder stopped, give up waiting after this long. */
const STOP_TIMEOUT_MS = 3000;

export interface RecorderOptions {
  /** Longest recording; onLimit fires once when it is reached. */
  maxMs?: number;
  onLimit?: () => void;
  /** The recorder failed or the microphone disappeared while recording. The device is already released. */
  onError?: () => void;
}

function friendlyError(e: unknown): Error {
  const err = e as { name?: string; message?: string };
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
    return new Error("Microphone permission was denied. Allow it in the browser to talk.");
  }
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") return new Error("No microphone was found.");
  return new Error(err?.message || "Could not open the microphone.");
}

/** Records the microphone while a key is held. Nothing is kept: stop() hands the audio back and releases the device. */
export class Recorder {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private starting = false;
  private leaveSession: (() => void) | null = null;

  constructor(private opts: RecorderOptions = {}) {}

  static supported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  get active(): boolean {
    return this.rec !== null;
  }

  async start(): Promise<void> {
    if (this.rec || this.starting) return;
    if (!Recorder.supported()) throw new Error("This browser cannot record audio here (use localhost or HTTPS).");
    this.starting = true;
    try {
      this.leaveSession = captureSession(); // on an iPhone the microphone can not open while the audio is "playback only"
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (e) {
        this.leaveSession?.();
        this.leaveSession = null;
        throw friendlyError(e);
      }
      try {
        const mimeType = MIME_PREFERENCE.find((t) => MediaRecorder.isTypeSupported(t));
        this.chunks = [];
        const rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
        rec.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) this.chunks.push(e.data);
        };
        rec.onerror = () => this.failed();
        for (const track of this.stream.getTracks()) track.onended = () => this.failed(); // unplugged, or permission revoked
        this.openMeter(this.stream);
        rec.start(250);
        this.rec = rec;
        if (this.opts.maxMs) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.opts.onLimit?.();
          }, this.opts.maxMs);
        }
      } catch (e) {
        this.release();
        throw friendlyError(e);
      }
    } finally {
      this.starting = false;
    }
  }

  /** Ends the recording and resolves with the audio. Always resolves, even if the browser misbehaves. */
  stop(): Promise<Blob> {
    const rec = this.rec;
    if (!rec) return Promise.reject(new Error("Not recording."));
    return new Promise<Blob>((resolve) => {
      let done = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
        this.release();
        resolve(blob);
      };
      timeout = setTimeout(finish, STOP_TIMEOUT_MS);
      rec.onstop = finish;
      if (rec.state === "inactive") return finish(); // already ended (device lost): nothing to wait for
      try {
        rec.stop();
      } catch {
        finish();
      }
    });
  }

  /** Throws the recording away and releases the microphone. */
  cancel(): void {
    const rec = this.rec;
    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.onerror = null;
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        /* already stopped */
      }
    }
    this.release();
  }

  /** Current input loudness, 0..1. */
  level(): number {
    if (!this.analyser || !this.rec) return 0;
    const data = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }

  private failed(): void {
    if (!this.rec) return;
    this.cancel();
    this.opts.onError?.();
  }

  private openMeter(stream: MediaStream): void {
    try {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.ctx.createMediaStreamSource(stream).connect(this.analyser);
    } catch {
      this.analyser = null; // the level meter is optional
    }
  }

  private release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.rec = null;
    this.ctx = null;
    this.analyser = null;
    this.chunks = [];
    this.leaveSession?.(); // the microphone is closed: sound goes back to playing through the silent switch
    this.leaveSession = null;
  }
}
