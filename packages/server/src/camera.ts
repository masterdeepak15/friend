import type { ServerMsg } from "@friend/protocol";
import { randomUUID } from "node:crypto";

export type CameraResult = { ok: true; mime: "image/jpeg"; data: string; frames?: { mime: "image/jpeg"; data: string }[] } | { ok: false; error: string };

/** All the frames of one clip together may not be larger than this. */
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;

const DENIED: Record<string, string> = {
  off: "The owner has the camera switched off.",
  "no-camera": "No camera was found.",
  permission: "Camera permission was denied in the browser.",
  busy: "The camera is in use by another app.",
};

const SCREEN_DENIED: Record<string, string> = {
  unsupported: "This browser cannot take a picture of the Friend screen.",
  failed: "The screen could not be captured.",
  busy: "Another picture of the screen is being taken.",
};

const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

interface Pending {
  id: string;
  emit: (m: ServerMsg) => void;
  finish: (r: CameraResult) => void;
  /** How many frames the browser was asked for (1 for a single picture), what has arrived, and how many bytes that is. */
  want: number;
  got: string[];
  bytes: number;
}

/**
 * Hands one picture request at a time to the browser and waits for the answer. The same broker serves the camera and the
 * picture of the Friend screen (kind "screen"); they differ only in the messages they send and the words they use.
 */
export class CameraBroker {
  private pending: Pending | null = null;
  private what: string;

  constructor(private timeoutMs = 20_000, private kind: "camera" | "screen" = "camera") {
    this.what = kind === "camera" ? "camera" : "screen picture";
  }

  private msg(type: "request" | "cancel", id: string, clip?: { frames: number; seconds: number }): ServerMsg {
    return { type: `${this.kind}.${type}`, id, ...(clip ? clip : {}) } as ServerMsg;
  }

  pendingId(): string | null {
    return this.pending?.id ?? null;
  }

  request(emit: (m: ServerMsg) => void, signal: AbortSignal, clipAsked?: { frames: number; seconds: number }): Promise<CameraResult> {
    // a short clip: 2 to 12 frames over 1 to 10 seconds, whatever was asked
    const clip = clipAsked ? { frames: Math.min(12, Math.max(2, Math.round(clipAsked.frames))), seconds: Math.min(10, Math.max(1, Math.round(clipAsked.seconds))) } : undefined;
    if (this.pending) return Promise.resolve({ ok: false, error: `The ${this.what} is already in use.` });
    if (signal.aborted) return Promise.resolve({ ok: false, error: `The ${this.what} request was cancelled.` });
    const id = randomUUID();
    return new Promise<CameraResult>((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish({ ok: false, error: `The ${this.what} did not answer in time.` }), this.timeoutMs + (clip ? clip.seconds * 1000 : 0));
      const onAbort = () => {
        emit(this.msg("cancel", id));
        finish({ ok: false, error: `The ${this.what} request was cancelled.` });
      };
      const finish = (r: CameraResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.pending?.id === id) this.pending = null;
        resolve(r);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = { id, emit, finish, want: clip ? clip.frames : 1, got: [], bytes: 0 };
      emit(this.msg("request", id, clip));
    });
  }

  /** A picture arrived from the browser. "invalid" leaves the request waiting for a proper one. */
  deliver(id: string, jpeg: Buffer): "ok" | "unknown" | "invalid" {
    const p = this.pending;
    if (!p || p.id !== id) return "unknown";
    if (!isJpeg(jpeg)) return "invalid";
    if (p.want > 1) {
      if (p.bytes + jpeg.length > MAX_CLIP_BYTES) return "invalid";
      p.bytes += jpeg.length;
      p.got.push(jpeg.toString("base64"));
      if (p.got.length >= p.want) p.finish({ ok: true, mime: "image/jpeg", data: p.got[0]!, frames: p.got.map((data) => ({ mime: "image/jpeg" as const, data })) });
      return "ok";
    }
    p.finish({ ok: true, mime: "image/jpeg", data: jpeg.toString("base64") });
    return "ok";
  }

  /** The browser could not or would not take a picture. Unknown reasons are never passed on. */
  deny(id: string, reason: string): boolean {
    const p = this.pending;
    if (!p || p.id !== id) return false;
    const table = this.kind === "camera" ? DENIED : SCREEN_DENIED;
    p.finish({ ok: false, error: table[reason] ?? `The ${this.what} could not be used.` });
    return true;
  }

  /** Emergency lock, shutdown: every browser is told to stop and the waiting tool gets an answer. */
  cancelAll(emit: (m: ServerMsg) => void): void {
    const p = this.pending;
    if (!p) return;
    emit(this.msg("cancel", p.id));
    p.finish({ ok: false, error: `The ${this.what} request was cancelled.` });
  }
}
