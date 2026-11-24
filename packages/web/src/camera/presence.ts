import type { ClientMsg } from "@friend/protocol";
import type { LocalAction } from "../store";
import { openCamera } from "./controller";

/** Pictures for this are small: faces only need to be found, and a smaller picture is quicker. */
const SIDE = 640;

export interface PresenceWatcherOptions {
  send(m: ClientMsg): void;
  dispatch(a: LocalAction): void;
  /** The faces in a picture, as 128 numbers each (see ../faces). Never throws. */
  faces(jpeg: Blob): Promise<number[][]>;
  open?: () => Promise<MediaStream>;
  frame?: (stream: MediaStream) => Promise<Blob>;
  /** False while the page is hidden: the camera is closed then. */
  visible?: () => boolean;
  /** How often to look (milliseconds). */
  everyMs?: number;
  /** After the camera could not be opened, how long to wait before trying again. */
  retryMs?: number;
}

/** One frame from a running stream, no larger than 640 px on its longest side. */
async function grab(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  const scale = Math.min(1, SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the picture."))), "image/jpeg", 0.7));
}

/**
 * Keeps the camera open while the owner's eye is on and the page is showing, and every few seconds tells the server which faces are
 * in front of the screen: only the numbers, never a picture. The camera light and the on-screen indicator show it all the time.
 * It closes at once when the eye goes off, the page is hidden, or the owner switches the camera off here.
 */
export class PresenceWatcher {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastSent = 0;
  private lastEmpty = false;
  private run = 0;

  constructor(private o: PresenceWatcherOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const run = ++this.run;
    void this.tick(run);
  }

  stop(): void {
    this.running = false;
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.close();
  }

  /** A copy of the running stream for a picture that was asked for, so the look can end its own copy without ending this one. */
  lend(): MediaStream | null {
    return this.stream ? this.stream.clone() : null;
  }

  private close(): void {
    const s = this.stream;
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    s?.getTracks().forEach((t) => t.stop());
    if (s) this.o.dispatch({ type: "camera.watch", stream: null });
  }

  private later(run: number, ms: number): void {
    if (run !== this.run) return;
    this.timer = setTimeout(() => void this.tick(run), ms);
  }

  private async tick(run: number): Promise<void> {
    if (run !== this.run) return;
    const every = this.o.everyMs ?? 4000;
    if (this.o.visible && !this.o.visible()) {
      this.close();
      return this.later(run, every);
    }
    try {
      if (!this.stream) {
        const stream = await (this.o.open ?? openCamera)();
        if (run !== this.run) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        this.stream = stream;
        this.o.dispatch({ type: "camera.watch", stream });
        if (!this.o.frame) {
          const v = document.createElement("video");
          v.muted = true;
          v.playsInline = true;
          v.srcObject = stream;
          await v.play();
          this.video = v;
          await new Promise((r) => setTimeout(r, 400)); // the first frames are dark while the exposure settles
        }
      }
      const jpeg = await (this.o.frame ? this.o.frame(this.stream!) : grab(this.video!));
      if (run !== this.run) return;
      const faces = await this.o.faces(jpeg);
      if (run !== this.run) return;
      // nobody twice in a row needs saying only now and then, so the server still knows somebody is watching
      const now = Date.now();
      if (faces.length || !this.lastEmpty || now - this.lastSent > 20_000) {
        this.o.send({ type: "presence.faces", faces });
        this.lastSent = now;
      }
      this.lastEmpty = faces.length === 0;
      this.later(run, every);
    } catch {
      this.close();
      // refused (permission) or not there: try again later, quietly; the owner's other looks still tell them why
      this.later(run, this.o.retryMs ?? 60_000);
    }
  }
}
