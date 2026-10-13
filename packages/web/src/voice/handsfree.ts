/** What the page needs from the always-open microphone (see listener.ts). */
export interface ListenerLike {
  start(): Promise<void>;
  stop(): void;
  pause(on: boolean): void;
  /** Current input loudness, 0..1. */
  level(): number;
  readonly listening: boolean;
}

export interface HandsFreeDeps {
  makeListener: (o: { onUtterance: (audio: Blob) => void; onError: (message: string) => void }) => ListenerLike;
  /** Ask the server whether this began with the assistant's name; the server runs the request when one came with it. */
  wake: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string; wake: boolean }>;
  /** Send a request to the ordinary voice route (the speaker check and every rule there apply). */
  command: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>;
  /** The page's voice mode: idle, listening, transcribing or speaking. */
  mode: () => string;
  chime: () => void;
  dispatch: (a: unknown) => void;
  /** How long Friend stays awake with nothing said. It does not run while Friend is working or speaking. */
  awakeMs?: number;
}

/** Errors that only mean "not now": the next thing said will simply be tried again. */
const QUIET = /busy with the last request|talking too fast/i;
const ALERT_EVERY_MS = 30_000;
const LEVEL_POLL_MS = 50;

/**
 * Hands-free: "hey <name>, ...". Asleep, each thing said goes to the server, which answers whether it began with the name
 * (and runs the request when one came with it). After the name Friend is awake: everything said is a request, with no
 * name needed, until 30 seconds pass with nothing said. The 30 seconds only run while Friend is quiet, so when it asks
 * a question the answer has the full time after it stops speaking.
 */
export class HandsFree {
  private listener: ListenerLike | null = null;
  private awakeNow = false;
  /** The page shows "listening" because of us (not because a key is held). */
  private showing = false;
  private busyWithOne = false;
  private clock: ReturnType<typeof setTimeout> | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private lastAlert = 0;

  constructor(private deps: HandsFreeDeps) {}

  get enabled(): boolean {
    return this.listener !== null;
  }

  get awake(): boolean {
    return this.awakeNow;
  }

  async enable(): Promise<void> {
    if (this.listener) return;
    const listener = this.deps.makeListener({
      onUtterance: (audio) => void this.heard(audio),
      onError: (message) => {
        this.drop();
        this.alert(message, true);
      },
    });
    try {
      await listener.start();
    } catch (e) {
      this.alert((e as Error).message, true);
      return;
    }
    this.listener = listener;
  }

  disable(): void {
    this.drop();
  }

  /** The page's voice mode changed (or time passed): stop collecting while Friend talks or a key is held, and keep the awake clock and animation right. */
  sync(): void {
    const listener = this.listener;
    if (!listener) return;
    const busy = this.busyOther();
    listener.pause(busy);
    if (!this.awakeNow || busy) {
      this.clearClock();
      this.stopMeter();
      return;
    }
    if (this.deps.mode() === "idle") this.show();
    if (!this.clock) this.startClock();
    this.startMeter();
  }

  private busyOther(): boolean {
    const m = this.deps.mode();
    if (m !== "listening") this.showing = false;
    return m === "speaking" || m === "transcribing" || (m === "listening" && !this.showing);
  }

  private show(): void {
    this.showing = true;
    this.deps.dispatch({ type: "voice.mode", mode: "listening" });
  }

  private wakeUp(withChime: boolean): void {
    this.awakeNow = true;
    if (withChime) this.deps.chime();
    this.clearClock();
    this.show();
    this.startClock();
    this.startMeter();
  }

  private sleep(): void {
    this.awakeNow = false;
    this.clearClock();
    this.stopMeter();
    if (this.showing) this.deps.dispatch({ type: "voice.mode", mode: "idle" });
    this.showing = false;
  }

  private drop(): void {
    const listener = this.listener;
    this.listener = null;
    this.abort?.abort();
    this.abort = null;
    this.busyWithOne = false;
    this.sleep();
    listener?.stop();
  }

  private startClock(): void {
    this.clearClock();
    this.clock = setTimeout(() => {
      this.clock = null;
      this.sleep();
    }, this.deps.awakeMs ?? 30_000);
  }

  private clearClock(): void {
    if (this.clock) clearTimeout(this.clock);
    this.clock = null;
  }

  /** The orb moves with the voice while Friend is waiting for the owner, as it does for the held key. */
  private startMeter(): void {
    if (this.meter) return;
    this.meter = setInterval(() => this.deps.dispatch({ type: "voice.level", level: this.listener?.level() ?? 0 }), LEVEL_POLL_MS);
  }

  private stopMeter(): void {
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
  }

  private async heard(audio: Blob): Promise<void> {
    if (!this.listener || this.busyWithOne || this.busyOther()) return; // one at a time, and never while Friend talks
    this.busyWithOne = true;
    const ac = new AbortController();
    this.abort = ac;
    try {
      if (this.awakeNow) await this.request(audio, ac.signal);
      else await this.check(audio, ac.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError" && !QUIET.test((e as Error).message)) this.alert((e as Error).message, false);
    } finally {
      if (this.abort === ac) this.abort = null;
      this.busyWithOne = false;
      if (this.listener && this.awakeNow) {
        this.clearClock(); // the 30 seconds start again from here
        if (this.deps.mode() === "transcribing") this.deps.dispatch({ type: "voice.mode", mode: "idle" });
        this.sync();
      }
    }
  }

  /** Asleep: was the name said? */
  private async check(audio: Blob, signal: AbortSignal): Promise<void> {
    const r = await this.deps.wake(audio, signal);
    if (!this.listener || !r.wake) return;
    this.wakeUp(!r.text); // with a request the server already runs it; with the name alone a chime says "go ahead"
  }

  /** Awake: whatever was said is the request. */
  private async request(audio: Blob, signal: AbortSignal): Promise<void> {
    this.clearClock();
    this.stopMeter();
    this.showing = false;
    this.deps.dispatch({ type: "voice.mode", mode: "transcribing" });
    await this.deps.command(audio, signal);
  }

  private alert(text: string, always: boolean): void {
    const now = Date.now();
    if (!always && now - this.lastAlert < ALERT_EVERY_MS) return;
    this.lastAlert = now;
    this.deps.dispatch({ type: "alert.add", level: "error", text });
  }
}
