import type { VoiceMode } from "../../../store";
import { Spectrum, clamp } from "../kit";

const BARS = 16;
/** A fixed, uneven profile so the bars look like a voice rather than a wall; the loudness scales all of them. */
const SHAPE = Array.from({ length: BARS }, (_, i) => 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + 1)));

/** Sound bars that follow the microphone or the voice, with what the voice is doing. */
export function VoiceWidget({ level, mode }: { level: number; mode: VoiceMode }) {
  const l = clamp(level, 0, 1);
  return (
    <div className="ob-voice">
      <Spectrum levels={SHAPE.map((s) => l * s)} />
      <small className="ob-sub">{mode}</small>
    </div>
  );
}