import type { ClientMsg } from "@friend/protocol";
import type { LocalAction } from "../store";

const MAX_SIDE = 1024;
const JPEG_QUALITY = 0.8;
/** The first frames from a camera are often dark while exposure settles. */
const WARMUP_MS = 300;

type Denial = Extract<ClientMsg, { type: "camera.denied" }>["reason"];

/** Largest side 1024 px, same shape, never enlarged. */
export function fitSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** Browser errors become one of the reasons the server understands; anything unexpected counts as 'in use'. */
export function reasonFor(e: unknown): Denial {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "permission";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-camera";
  return "busy";
}

export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // no camera API at all: an insecure page (not localhost or HTTPS) or an old browser
    throw Object.assign(new Error("This browser cannot use the camera here (use localhost or HTTPS)."), { name: "NotFoundError" });
  }
  return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } }, audio: false });
}

/** Grabs one frame from the stream as a JPEG no larger than 1024 px on its longest side. */
export async function captureJpeg(stream: MediaStream, warmupMs = WARMUP_MS): Promise<Blob> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => setTimeout(r, warmupMs));
  const { width, height } = fitSize(video.videoWidth || 640, video.videoHeight || 480);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);
  video.srcObject = null;
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the picture."))), "image/jpeg", JPEG_QUALITY),
  );
}

export interface CameraControllerOptions {
  send(m: ClientMsg): void;
  upload(id: string, jpeg: Blob): Promise<void>;
  dispatch(a: LocalAction): void;
  /** Whether the owner has switched the camera on. */
  enabled(): boolean;
  open?: () => Promise<MediaStream>;
  frame?: (stream: MediaStream) => Promise<Blob>;
}

interface Active {
  id: string;
  cancelled: boolean;
  stream: MediaStream | null;
  opened: boolean;
  released: boolean;
}

/**
 * Takes one picture when the server asks, and only then. The camera is opened for that picture and released right
 * after, on every path: success, failure, cancel and dispose.
 */
export class CameraController {
  private active: Active | null = null;

  constructor(private opts: CameraControllerOptions) {}

  async handle(m: { type: "camera.request" | "camera.cancel"; id: string }): Promise<void> {
    if (m.type === "camera.cancel") {
      const a = this.active;
      if (a && a.id === m.id) {
        a.cancelled = true;
        this.release(a);
      }
      return;
    }
    if (!this.opts.enabled()) return this.opts.send({ type: "camera.denied", id: m.id, reason: "off" });
    if (this.active) return this.opts.send({ type: "camera.denied", id: m.id, reason: "busy" });

    const a: Active = { id: m.id, cancelled: false, stream: null, opened: false, released: false };
    this.active = a;
    try {
      const stream = await (this.opts.open ?? openCamera)();
      a.stream = stream;
      if (a.cancelled) {
        // cancelled while the browser was still opening the camera: the stream only exists now, so stop it now
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      a.opened = true;
      this.opts.dispatch({ type: "camera.open", stream });
      const jpeg = await (this.opts.frame ?? ((s) => captureJpeg(s)))(stream);
      if (a.cancelled) return;
      this.release(a); // the camera goes off before the upload, not after
      try {
        await this.opts.upload(m.id, jpeg);
      } catch {
        this.opts.dispatch({ type: "alert.add", level: "warn", text: "Could not send the camera picture to Friend." });
      }
    } catch (e) {
      if (!a.cancelled) this.opts.send({ type: "camera.denied", id: m.id, reason: reasonFor(e) });
    } finally {
      this.release(a);
      if (this.active === a) this.active = null;
    }
  }

  dispose(): void {
    const a = this.active;
    if (!a) return;
    a.cancelled = true;
    this.release(a);
  }

  private release(a: Active): void {
    if (a.released) return;
    a.released = true;
    a.stream?.getTracks().forEach((t) => t.stop());
    if (a.opened) this.opts.dispatch({ type: "camera.closed" });
  }
}
