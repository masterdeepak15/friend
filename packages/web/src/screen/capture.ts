import type { ClientMsg } from "@friend/protocol";
import { toCanvas } from "html-to-image";
import type { LocalAction } from "../store";

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;

type Denial = Extract<ClientMsg, { type: "screen.denied" }>["reason"];

/** Largest side 1600 px, same shape, never enlarged. */
export function fitScreen(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Draws the Friend page into a JPEG, with nothing but this page's own pixels (no plugin, no screen sharing prompt).
 * Frames (sandbox pages, PDFs) and playing video do not appear in it.
 */
export async function captureScreen(): Promise<Blob> {
  const root = document.documentElement;
  const rect = root.getBoundingClientRect();
  const canvas = await toCanvas(document.body, {
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    pixelRatio: 1,
    backgroundColor: "#050b10",
    filter: (node) => !(node instanceof HTMLElement && node.dataset.noCapture !== undefined),
  });
  const size = fitScreen(canvas.width, canvas.height);
  const out = document.createElement("canvas");
  out.width = size.width;
  out.height = size.height;
  out.getContext("2d")!.drawImage(canvas, 0, 0, size.width, size.height);
  return new Promise<Blob>((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the picture."))), "image/jpeg", JPEG_QUALITY));
}

export interface ScreenControllerOptions {
  send(m: ClientMsg): void;
  upload(id: string, jpeg: Blob): Promise<void>;
  dispatch(a: LocalAction): void;
  capture?: () => Promise<Blob>;
}

/** Takes one picture of this page when the server asks (after the owner's PIN), and only then. */
export class ScreenController {
  private active: { id: string; cancelled: boolean } | null = null;

  constructor(private opts: ScreenControllerOptions) {}

  async handle(m: { type: "screen.request" | "screen.cancel"; id: string }): Promise<void> {
    if (m.type === "screen.cancel") {
      if (this.active && this.active.id === m.id) this.active.cancelled = true;
      return;
    }
    if (this.active) return this.opts.send({ type: "screen.denied", id: m.id, reason: "busy" });
    const a = { id: m.id, cancelled: false };
    this.active = a;
    try {
      const jpeg = await (this.opts.capture ?? captureScreen)();
      if (a.cancelled) return;
      try {
        await this.opts.upload(m.id, jpeg);
      } catch {
        this.opts.dispatch({ type: "alert.add", level: "warn", text: "Could not send the picture of the screen to Friend." });
      }
    } catch (e) {
      if (!a.cancelled) this.opts.send({ type: "screen.denied", id: m.id, reason: reasonFor(e) });
    } finally {
      if (this.active === a) this.active = null;
    }
  }

  dispose(): void {
    if (this.active) this.active.cancelled = true;
  }
}

function reasonFor(e: unknown): Denial {
  return (e as { name?: string } | null)?.name === "NotSupportedError" ? "unsupported" : "failed";
}
