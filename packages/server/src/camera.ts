import type { ServerMsg } from "@friend/protocol";
import { randomUUID } from "node:crypto";

export type CameraResult = { ok: true; mime: "image/jpeg"; data: string } | { ok: false; error: string };

const DENIED: Record<string, string> = {
  off: "The owner has the camera switched off.",
  "no-camera": "No camera was found.",
  permission: "Camera permission was denied in the browser.",
  busy: "The camera is in use by another app.",
};

const isJpeg = (b: Buffer) => b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

interface Pending {
  id: string;
  emit: (m: ServerMsg) => void;
  finish: (r: CameraResult) => void;
}

/** Hands one picture request at a time to the browser and waits for the answer. */
export class CameraBroker {
  private pending: Pending | null = null;

  constructor(private timeoutMs = 20_000) {}

  pendingId(): string | null {
    return this.pending?.id ?? null;
  }

  request(emit: (m: ServerMsg) => void, signal: AbortSignal): Promise<CameraResult> {
    if (this.pending) return Promise.resolve({ ok: false, error: "The camera is already in use." });
    if (signal.aborted) return Promise.resolve({ ok: false, error: "The camera request was cancelled." });
    const id = randomUUID();
    return new Promise<CameraResult>((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish({ ok: false, error: "The camera did not answer in time." }), this.timeoutMs);
      const onAbort = () => {
        emit({ type: "camera.cancel", id });
        finish({ ok: false, error: "The camera request was cancelled." });
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
      this.pending = { id, emit, finish };
      emit({ type: "camera.request", id });
    });
  }

  /** A picture arrived from the browser. "invalid" leaves the request waiting for a proper one. */
  deliver(id: string, jpeg: Buffer): "ok" | "unknown" | "invalid" {
    const p = this.pending;
    if (!p || p.id !== id) return "unknown";
    if (!isJpeg(jpeg)) return "invalid";
    p.finish({ ok: true, mime: "image/jpeg", data: jpeg.toString("base64") });
    return "ok";
  }

  /** The browser could not or would not take a picture. Unknown reasons are never passed on. */
  deny(id: string, reason: string): boolean {
    const p = this.pending;
    if (!p || p.id !== id) return false;
    p.finish({ ok: false, error: DENIED[reason] ?? "The camera could not be used." });
    return true;
  }

  /** Emergency lock, shutdown: every browser is told to stop and the waiting tool gets an answer. */
  cancelAll(emit: (m: ServerMsg) => void): void {
    const p = this.pending;
    if (!p) return;
    emit({ type: "camera.cancel", id: p.id });
    p.finish({ ok: false, error: "The camera request was cancelled." });
  }
}
