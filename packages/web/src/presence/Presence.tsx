import type { PresenceState, PresenceStyle } from "@friend/protocol";
import { useEffect, useRef } from "react";
import { detectEnv } from "./capability";
import type { PresenceHandle, PresenceMode } from "./core";
import { createPresence } from "./factory";

export interface PresenceProps {
  state: PresenceState;
  amplitude: number;
  /** Increments on every new audio/text pulse so repeated equal amplitudes still register. */
  pulse?: number;
  mode: PresenceMode;
  accent?: string;
  style?: PresenceStyle;
  /** Mood intensity 0..1. */
  intensity?: number;
}

export function Presence({ state, amplitude, pulse = 0, mode, accent = "#3fd8ff", style = "sphere", intensity = 0.6 }: PresenceProps) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<PresenceHandle | null>(null);
  const latest = useRef({ state, amplitude, mode, accent, intensity });
  latest.current = { state, amplitude, mode, accent, intensity };

  // A style change disposes the old handle and builds a new one carrying over the current settings.
  useEffect(() => {
    const cur = latest.current;
    const h = createPresence(style, host.current!, { accent: cur.accent, reducedMotion: detectEnv().reducedMotion });
    h.setState(cur.state);
    h.setAmplitude(cur.amplitude);
    h.setIntensity(cur.intensity);
    h.setMode(cur.mode);
    handle.current = h;
    return () => {
      h.dispose();
      handle.current = null;
    };
  }, [style]);

  useEffect(() => handle.current?.setState(state), [state]);
  useEffect(() => handle.current?.setAmplitude(amplitude), [amplitude, pulse]);
  useEffect(() => handle.current?.setMode(mode), [mode]);
  useEffect(() => handle.current?.setAccent(accent), [accent]);
  useEffect(() => handle.current?.setIntensity(intensity), [intensity]);

  return <div ref={host} data-presence data-mode={mode} data-style={style} data-state={state} data-amplitude={amplitude.toFixed(2)} className={`presence presence-${mode}`} aria-hidden="true" />;
}
