/** What the page needs from the always-open microphone (see listener.ts). */
export interface ListenerLike {
  start(): Promise<void>;
  stop(): void;
  pause(on: boolean): void;
  readonly listening: boolean;
}

export interface HandsFreeDeps {
  makeListener: (o: { onUtterance: (audio: Blob) => void; onError: (message: string) => void }) => ListenerLike;
  /** Ask the server whether this began with the assistant's name; the server runs the request when one came with it. */
  wake: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string; wake: boolean }>;
  /** Send a request to the ordinary voice route (the speaker check and every rule there apply). */
  command: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>;
  /** True while Friend is speaking, transcribing, or a key is held. */
  busy: () => boolean;
  chime: () => void;
  dispatch: (a: unknown) => void;
  /** How long to wait for the request after the name alone was said. */
  followUpMs?: number;
}

/** Errors that only mean "not now": the next thing said will simply be tried again. */
const QUIET = /busy with the last request|talking too fast/i;
const ALERT_EVERY_MS = 30_000;

/**
 * Hands-free: "hey <name>, ...". It never decides anything itself. Each thing said goes to the server, which answers whether it
 * began with the name and runs the request when one came with it; a request after the bare name goes through the ordinary route.
 */
export class HandsFree {
  private listener: ListenerLike | null = null;
  private state: "armed" | "checking" | "awaiting" = "armed";
  private followUp: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private lastAlert = 0;

  constructor(private deps: HandsFreeDeps) {}

  get enabled(): boolean {
    return this.listener !== null;
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
    this.state = "armed";
  }

  disable(): void {
    this.drop();
  }

  /** The page's voice mode changed: stop collecting while Friend talks or a key is held, but not while waiting for the request. */
  sync(): void {
    this.listener?.pause(this.deps.busy() && this.state !== "awaiting");
  }

  private drop(): void {
    const listener = this.listener;
    this.listener = null;
    this.abort?.abort();
    this.abort = null;
    this.endWait();
    this.state = "armed";
    listener?.stop();
  }

  private endWait(): void {
    if (this.followUp) clearTimeout(this.followUp);
    this.followUp = null;
    if (this.state === "awaiting") this.deps.dispatch({ type: "voice.mode", mode: "idle" });
    if (this.state === "awaiting") this.state = "armed";
  }

  private async heard(audio: Blob): Promise<void> {
    if (!this.listener) return;
    if (this.state === "checking") return; // one at a time
    if (this.state === "awaiting") return void this.request(audio);
    if (this.deps.busy()) return;
    this.state = "checking";
    const ac = new AbortController();
    this.abort = ac;
    try {
      const r = await this.deps.wake(audio, ac.signal);
      if (!this.listener) return;
      if (r.wake && !r.text) this.wait();
    } catch (e) {
      if ((e as Error).name !== "AbortError" && !QUIET.test((e as Error).message)) this.alert((e as Error).message, false);
    } finally {
      if (this.abort === ac) this.abort = null;
      if (this.state === "checking") this.state = "armed";
    }
  }

  /** The name alone was said: signal it, and listen for the request. */
  private wait(): void {
    this.state = "awaiting";
    this.deps.chime();
    this.deps.dispatch({ type: "voice.mode", mode: "listening" });
    this.followUp = setTimeout(() => {
      this.followUp = null;
      this.endWait();
    }, this.deps.followUpMs ?? 8000);
  }

  private async request(audio: Blob): Promise<void> {
    this.endWait();
    this.deps.dispatch({ type: "voice.mode", mode: "transcribing" });
    this.state = "checking";
    const ac = new AbortController();
    this.abort = ac;
    try {
      await this.deps.command(audio, ac.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError" && !QUIET.test((e as Error).message)) this.alert((e as Error).message, false);
    } finally {
      if (this.abort === ac) this.abort = null;
      if (this.state === "checking") this.state = "armed";
      this.deps.dispatch({ type: "voice.mode", mode: "idle" });
    }
  }

  private alert(text: string, always: boolean): void {
    const now = Date.now();
    if (!always && now - this.lastAlert < ALERT_EVERY_MS) return;
    this.lastAlert = now;
    this.deps.dispatch({ type: "alert.add", level: "error", text });
  }
}
