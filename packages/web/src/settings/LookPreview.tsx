import { useEffect, useState } from "react";
import { Presence } from "../presence/Presence";
import { reactivityFactor } from "../presence/reactivity";
import type { Look } from "./settingsApi";

/** A small live copy of the voice presence, speaking, so the choices can be judged before they are saved. */
export function LookPreview({ look }: { look: Look }) {
  const [amp, setAmp] = useState(0.4);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setAmp(0.3 + Math.random() * 0.5);
      setPulse((p) => p + 1);
    }, 600);
    return () => clearInterval(id);
  }, []);
  const reactivity = reactivityFactor(look.reactivity); // the same as on the real screen
  return (
    <div className="look-preview" data-testid="look-preview" role="img" aria-label="Preview of the voice presence">
      {look.ambient && <div className="look-preview-glow" style={{ opacity: 0.35 + 0.65 * look.intensity, ["--accent" as string]: look.accent }} />}
      <div className="look-preview-stage" style={{ ["--accent" as string]: look.accent }}>
        <Presence state="speaking" amplitude={Math.min(1, amp * reactivity)} pulse={pulse} mode="full" accent={look.accent} style={look.style} intensity={look.intensity} scale={look.size} />
      </div>
      {look.captions && <p className={`look-preview-caption captions-${look.captionSize}`}>This is how my words will look.</p>}
    </div>
  );
}
