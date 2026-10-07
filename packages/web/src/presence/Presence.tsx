import type { PresenceState } from "@friend/protocol";
import { useEffect, useRef } from "react";
import { detectEnv, pickParticleCount } from "./capability";
import type { PresenceHandle, PresenceMode } from "./core";
import { Fallback2D } from "./fallback2d";
import { ParticleSphere } from "./sphere";

export interface PresenceProps {
  state: PresenceState;
  amplitude: number;
  /** Increments on every new audio/text pulse so repeated equal amplitudes still register. */
  pulse?: number;
  mode: PresenceMode;
  accent?: string;
}

function createHandle(host: HTMLElement, accent: string): PresenceHandle {
  const env = detectEnv();
  const count = pickParticleCount(env);
  if (count > 0) {
    try {
      return new ParticleSphere(host, count, accent, env.reducedMotion);
    } catch {
      /* WebGL context creation failed: fall through to 2D */
    }
  }
  return new Fallback2D(host, count || 8000, accent, env.reducedMotion);
}

export function Presence({ state, amplitude, pulse = 0, mode, accent = "#3fd8ff" }: PresenceProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PresenceHandle | null>(null);

  useEffect(() => {
    const h = createHandle(host.current!, accent);
    handle.current = h;
    return () => {
      h.dispose();
      handle.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => handle.current?.setState(state), [state]);
  useEffect(() => handle.current?.setAmplitude(amplitude), [amplitude, pulse]);
  useEffect(() => handle.current?.setMode(mode), [mode]);
  useEffect(() => handle.current?.setAccent(accent), [accent]);

  return <div ref={host} data-presence data-mode={mode} className={`presence presence-${mode}`} aria-hidden="true" />;
}
