const TICK_MS = 30;
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1);

/**
 * How loud music and video are on this screen while someone talks: 1 is as the owner has it, 0.25 a quarter. The server says
 * what level (the owner's setting); this slides there over a moment so the sound eases down and up instead of jumping.
 */
export class DuckLevel {
  private current = 1;
  private goal = 1;
  private from = 1;
  private steps = 1;
  private n = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs = new Set<(level: number) => void>();

  get level(): number {
    return this.current;
  }

  set(goal: number, rampMs = 250): void {
    this.goal = clamp01(goal);
    if (rampMs <= 0 || this.goal === this.current) {
      this.stop();
      this.move(this.goal);
      return;
    }
    this.from = this.current;
    this.steps = Math.max(1, Math.ceil(rampMs / TICK_MS));
    this.n = 0;
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  /** Called with each new level. Returns the way to stop listening. */
  subscribe(cb: (level: number) => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  private tick(): void {
    this.n++;
    if (this.n >= this.steps) {
      this.stop();
      this.move(this.goal);
    } else this.move(this.from + ((this.goal - this.from) * this.n) / this.steps);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private move(level: number): void {
    if (level === this.current) return;
    this.current = level;
    for (const cb of [...this.subs]) cb(level);
  }
}

/** The level for this screen. */
export const pageDuck = new DuckLevel();

/**
 * Keeps a <video> or <audio> element turned down by the current level. The volume the viewer chose is remembered: if they move
 * the slider while it is turned down, that is their new volume, and it comes back to that. Returns the way to stop (the
 * element's own volume is put back).
 */
export function duckMedia(el: HTMLMediaElement, level: DuckLevel = pageDuck): () => void {
  let base = el.volume;
  let ours = el.volume;
  let on = true;
  const apply = (l: number) => {
    if (!on) return;
    ours = clamp01(base * l);
    el.volume = ours;
  };
  const changed = () => {
    if (!on || Math.abs(el.volume - ours) <= 0.002) return; // our own change coming back
    const l = level.level;
    if (l > 0.001) base = clamp01(el.volume / l);
    ours = el.volume;
  };
  el.addEventListener("volumechange", changed);
  const off = level.subscribe(apply);
  apply(level.level);
  return () => {
    on = false;
    off();
    el.removeEventListener("volumechange", changed);
    el.volume = base;
  };
}

const YOUTUBE = "https://www.youtube-nocookie.com";

/**
 * The same for YouTube's own embedded player, which is a page of its own: it is spoken to with messages (the player must have
 * been opened with enablejsapi=1). It reports its volume back, so what the viewer chose is known. Only what Friend lowered is
 * restored: a player nobody talked over is never touched.
 */
export function duckYoutube(frame: HTMLIFrameElement, level: DuckLevel = pageDuck, target: Window = window): () => void {
  let base = 100;
  let ours: number | null = null;
  let lowered = false;
  let on = true;
  let known = false;
  const post = (msg: object) => frame.contentWindow?.postMessage(JSON.stringify(msg), YOUTUBE);
  const listen = () => post({ event: "listening", id: 1, channel: "widget" });
  const setVolume = (v: number) => {
    ours = v;
    post({ event: "command", func: "setVolume", args: [v] });
  };
  const apply = (l: number) => {
    if (!on) return;
    if (l < 0.999) {
      lowered = true;
      setVolume(Math.round(base * l));
    } else if (lowered) {
      lowered = false;
      setVolume(Math.round(base));
    }
  };
  const onMessage = (e: MessageEvent) => {
    if (!on || e.source !== frame.contentWindow) return;
    let info: { volume?: unknown } | undefined;
    try {
      info = (JSON.parse(String(e.data)) as { info?: { volume?: unknown } }).info;
    } catch {
      return;
    }
    if (typeof info?.volume !== "number") return;
    known = true;
    const v = info.volume;
    if (ours !== null && Math.abs(v - ours) <= 1) return; // what Friend set, coming back
    const l = level.level;
    base = lowered && l > 0.001 ? v / l : v;
    ours = v;
  };
  target.addEventListener("message", onMessage as EventListener);
  frame.addEventListener?.("load", listen);
  listen();
  const retry = setInterval(() => (known ? clearInterval(retry) : listen()), 1000); // the player may not be ready for the first ask
  const off = level.subscribe(apply);
  apply(level.level);
  return () => {
    on = false;
    clearInterval(retry);
    off();
    target.removeEventListener("message", onMessage as EventListener);
    frame.removeEventListener?.("load", listen);
    if (lowered) setVolumeSafe(frame, base);
  };
}

function setVolumeSafe(frame: HTMLIFrameElement, v: number): void {
  try {
    frame.contentWindow?.postMessage(JSON.stringify({ event: "command", func: "setVolume", args: [Math.round(v)] }), YOUTUBE);
  } catch {
    /* the frame is already gone */
  }
}
