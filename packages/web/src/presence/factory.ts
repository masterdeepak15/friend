import type { PresenceStyle } from "@friend/protocol";
import { detectEnv, pickParticleCount, type PresenceEnv } from "./capability";
import type { PresenceHandle } from "./core";
import { Fallback2D } from "./fallback2d";
import { OrbPresence } from "./orb";
import { RingPresence } from "./ring";
import { ParticleSphere } from "./sphere";

export interface CreateOptions {
  accent: string;
  reducedMotion: boolean;
  /** Override environment detection (tests). */
  env?: PresenceEnv;
}

/** Builds the presence for a style. WebGL styles fall back to the 2D particle sphere when WebGL is unavailable or fails. */
export function createPresence(style: PresenceStyle, host: HTMLElement, opts: CreateOptions): PresenceHandle {
  const env = opts.env ?? detectEnv();
  const count = pickParticleCount({ ...env, reducedMotion: opts.reducedMotion });
  const fallback = () => new Fallback2D(host, count || 8000, opts.accent, opts.reducedMotion);

  if (style === "ring") return new RingPresence(host, opts.accent, opts.reducedMotion);
  if (count === 0) return fallback();
  try {
    if (style === "orb") return new OrbPresence(host, opts.accent, opts.reducedMotion);
    return new ParticleSphere(host, count, opts.accent, opts.reducedMotion);
  } catch {
    return fallback(); // WebGL context creation failed
  }
}
