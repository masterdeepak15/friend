import type { ServerMsg } from "@friend/protocol";
import { randomUUID } from "node:crypto";

export type ScreenCheckResult = { ok: true; lines: string[] } | { ok: false; error: string };

interface Pending {
  id: string;
  finish: (r: ScreenCheckResult) => void;
}

/**
 * Asks the owner's Friend screen how the drawing came out and waits for its report. The screen measures itself and sends back
 * short lines of text (overlaps, things cut off, empty cards), so no picture or vision model is needed. One request at a time.
 */
export class ScreenCheck {
  private pending: Pending | null = null;

  constructor(private timeoutMs = 10_000) {}

  request(emit: (m: ServerMsg) => void, signal: AbortSignal): Promise<ScreenCheckResult> {
    if (this.pending) return Promise.resolve({ ok: false, error: "The screen is already being checked." });
    if (signal.aborted) return Promise.resolve({ ok: false, error: "The screen check was cancelled." });
    const id = randomUUID();
    return new Promise<ScreenCheckResult>((resolve) => {
      let done = false;
      const timer = setTimeout(() => finish({ ok: false, error: "The screen did not answer in time. Friend may not be open in a browser." }), this.timeoutMs);
      const finish = (r: ScreenCheckResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.pending?.id === id) this.pending = null;
        resolve(r);
      };
      const onAbort = () => finish({ ok: false, error: "The screen check was cancelled." });
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending = { id, finish };
      emit({ type: "screen.check", id });
    });
  }

  /** The screen reported. An answer to anything but the waiting request is ignored. */
  reply(id: string, lines: string[]): boolean {
    const p = this.pending;
    if (!p || p.id !== id) return false;
    p.finish({ ok: true, lines });
    return true;
  }

  /** Emergency lock, shutdown: the waiting tool gets an answer. */
  cancelAll(): void {
    this.pending?.finish({ ok: false, error: "The screen check was cancelled." });
  }
}
