import type { VoiceMode } from "../../../store";
import { Spectrum, clamp } from "../kit";

const BARS = 20;
/** A fixed, uneven profile so the bars look like a voice rather than a wall; the loudness scales all of them. */
const SHAPE = Array.from({ length: BARS }, (_, i) => 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + 1)));
/** With no sound the bars stay small but alive, so the instrument never looks switched off. */
const IDLE_FLOOR = 0.45;

/** Sound bars that follow the microphone or the voice, with what the voice is doing. */
export function VoiceWidget({ level, mode }: { level: number; mode: VoiceMode }) {
  const l = clamp(level, 0, 1);
  const shown = Math.max(IDLE_FLOOR, l);
  const lit = Math.round(l * 5);
  return (
    <svg className="ob-wsvg" viewBox="0 0 300 160">
      <text className="ob-lab" x="0" y="8">VOICE · SPECTRUM</text>
      <line className="ob-ecg-base" x1="0" x2="300" y1="130" y2="130" />
      <Spectrum levels={SHAPE.map((s) => shown * s)} frame={{ x: 0, y: 40, w: 240, h: 90 }} />
      <text className="ob-dim" x="0" y="150">MIC {"▮".repeat(lit)}{"▯".repeat(5 - lit)} · {mode}</text>
    </svg>
  );
}