/** Where a control session is: none, counting down before the first move, running, or paused because the person at the PC took over. */
export type Phase = "idle" | "countdown" | "active" | "paused";

export interface ControlDeps {
  now(): number;
  /** Calls fn after ms; the returned function cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
  /** Called on every change, with why (for the banner and the status line). */
  onChange(phase: Phase, why: string): void;
  /** How long it counts down before the first move, and after a pause. */
  countdownMs?: number;
  /** A session with no tool call for this long ends by itself. */
  idleMs?: number;
}

/**
 * One control session at a time. It starts with a short countdown so the person at the PC sees the banner first, runs until its time
 * is up, goes quiet after an idle time, pauses the moment the person uses the mouse or keyboard, and ends with the hotkey.
 * Nothing here moves the mouse; it only says whether the agent may.
 */
export class Control {
  private phase_: Phase = "idle";
  private deadline: number | null = null;
  private cancels: (() => void)[] = [];
  private cancelIdle: (() => void) | null = null;
  private readonly countdownMs: number;
  private readonly idleMs: number;

  constructor(private readonly deps: ControlDeps) {
    this.countdownMs = deps.countdownMs ?? 3000;
    this.idleMs = deps.idleMs ?? 10 * 60_000;
  }

  phase(): Phase {
    return this.phase_;
  }

  /** The agent may use the mouse, the keyboard and the screen right now. */
  canAct(): boolean {
    return this.phase_ === "active" && (this.deadline === null || this.deps.now() < this.deadline);
  }

  /** Starts a session, or starts it again after a pause. The countdown runs first. */
  start(minutes = 30): { ok: true } | { ok: false; error: string } {
    if (this.phase_ === "countdown" || this.phase_ === "active") return { ok: false, error: "A control session is already running." };
    this.clear();
    this.deadline = this.deps.now() + minutes * 60_000;
    this.set("countdown", `starting in ${Math.round(this.countdownMs / 1000)} seconds`);
    this.cancels.push(
      this.deps.setTimer(() => {
        if (this.phase_ !== "countdown") return;
        this.set("active", "running");
        this.armIdle();
      }, this.countdownMs),
      this.deps.setTimer(() => this.end("time is up"), minutes * 60_000),
    );
    return { ok: true };
  }

  /** The agent used a tool: the session is not idle. */
  touch(): void {
    if (this.phase_ === "active") this.armIdle();
  }

  /** The person at the PC moved the mouse or pressed a key (not us): stop at once. */
  humanInput(): void {
    if (this.phase_ === "active" || this.phase_ === "countdown") {
      this.cancelCountdown();
      this.set("paused", "paused by you");
    }
  }

  /** The hotkey, a screen lock, a lost connection, a revoke: the session is over. */
  end(why: string): void {
    if (this.phase_ === "idle") return;
    this.clear();
    this.set("idle", why);
  }

  private armIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = this.deps.setTimer(() => this.end("idle for too long"), this.idleMs);
  }

  private cancelCountdown(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  private clear(): void {
    for (const c of this.cancels) c();
    this.cancels = [];
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.deadline = null;
  }

  private set(phase: Phase, why: string): void {
    this.phase_ = phase;
    this.deps.onChange(phase, why);
  }
}
