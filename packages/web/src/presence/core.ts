import type { PresenceState } from "@friend/protocol";

export type PresenceMode = "full" | "corner";

export interface PresenceHandle {
  setState(s: PresenceState): void;
  setAmplitude(v: number): void;
  setMode(m: PresenceMode): void;
  setAccent(color: string): void;
  dispose(): void;
}

export interface PresenceUniforms {
  amplitude: number;
  speed: number;
  noise: number;
  brightness: number;
  size: number;
  rotate: number;
  tighten: number;
  phase: number;
  angle: number;
}

type Params = Omit<PresenceUniforms, "amplitude" | "phase" | "angle">;

const TARGETS: Record<PresenceState, Params> = {
  idle: { speed: 0.15, noise: 0.05, brightness: 0.55, size: 1.6, rotate: 0.08, tighten: 0 },
  listening: { speed: 0.4, noise: 0.1, brightness: 0.9, size: 1.9, rotate: 0.15, tighten: 0.08 },
  thinking: { speed: 1.1, noise: 0.22, brightness: 0.8, size: 1.7, rotate: 0.35, tighten: 0 },
  speaking: { speed: 0.6, noise: 0.12, brightness: 1.0, size: 1.8, rotate: 0.12, tighten: 0 },
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** Renderer-independent animation state shared by the WebGL sphere and the 2D fallback. */
export class PresenceCore {
  state: PresenceState = "idle";
  amplitudeTarget = 0;
  private amp = 0;
  private cur: Params = { ...TARGETS.idle };
  private phase = 0;
  private angle = 0;
  private motion: number;

  constructor(opts: { reducedMotion?: boolean } = {}) {
    this.motion = opts.reducedMotion ? 0.25 : 1;
  }

  setState(s: PresenceState): void {
    this.state = s;
  }

  setAmplitude(v: number): void {
    this.amplitudeTarget = clamp01(v);
  }

  tick(dt: number): void {
    const target = TARGETS[this.state];
    const k = 1 - Math.exp(-dt * 3);
    for (const key of Object.keys(target) as (keyof Params)[]) this.cur[key] += (target[key] - this.cur[key]) * k;
    this.amp += (this.amplitudeTarget - this.amp) * (1 - Math.exp(-dt * 12));
    this.amplitudeTarget *= Math.exp(-dt * 3);
    this.phase += dt * this.cur.speed * this.motion;
    this.angle += dt * this.cur.rotate * this.motion;
  }

  uniforms(): PresenceUniforms {
    return {
      ...this.cur,
      speed: this.cur.speed * this.motion,
      rotate: this.cur.rotate * this.motion,
      amplitude: this.amp * (this.motion === 1 ? 1 : 0.5),
      phase: this.phase,
      angle: this.angle,
    };
  }
}
