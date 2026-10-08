import { useEffect, useRef, useState } from "react";
import type { VoiceMode } from "../store";

/** A press longer than this is "hold to talk" (release sends); a shorter tap keeps listening until the next tap. */
export const HOLD_MS = 450;

export interface TouchControlsProps {
  voice: { pressStart(): void; pressEnd(): void; blur?(): void };
  mode: VoiceMode;
  onType: () => void;
  onMenu: () => void;
}

const icon = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

const hint = (mode: VoiceMode, latched: boolean): string =>
  mode === "listening" ? (latched ? "Listening… tap to send" : "Listening… let go to send") : mode === "transcribing" ? "Understanding…" : mode === "speaking" ? "Tap to talk over me" : "Hold to talk, or tap once";

/**
 * Buttons for a screen with no keyboard: talk, type, and the owner menu.
 * Hold the microphone and let go to send, or tap it once to start and tap again to send.
 */
export function TouchControls({ voice, mode, onType, onMenu }: TouchControlsProps) {
  const press = useRef<{ at: number; id: number } | null>(null);
  const latched = useRef(false);
  const [tapMode, setTapMode] = useState(false); // the same as `latched`, for the words under the button
  const setLatched = (v: boolean) => {
    latched.current = v;
    setTapMode(v);
  };
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Whatever ended the recording (a time limit, a lost microphone, a new reply), a stale tap-to-listen must not outlive it.
  useEffect(() => {
    if (mode !== "listening" && !press.current) setLatched(false);
  }, [mode]);

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (press.current) return; // a second finger
    if (latched.current && modeRef.current === "listening") {
      setLatched(false);
      voice.pressEnd(); // the second tap sends
      return;
    }
    setLatched(false);
    press.current = { at: Date.now(), id: e.pointerId };
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    voice.pressStart();
  };
  const up = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (Date.now() - p.at >= HOLD_MS) voice.pressEnd();
    else setLatched(true); // a quick tap: keep listening until the next tap
  };
  const cancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    setLatched(false);
    voice.blur?.(); // a cancelled gesture discards the recording
  };

  const on = mode === "listening";
  return (
    <div className="touch-controls" data-testid="touch-controls">
      <button type="button" className="touch-side" aria-label="Open the menu" onClick={onMenu}>
        <svg {...icon}>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <div className="touch-talk">
        <button
          type="button"
          className={`touch-mic${on ? " on" : ""}`}
          aria-label="Talk to Friend"
          aria-pressed={on}
          onPointerDown={down}
          onPointerUp={up}
          onPointerCancel={cancel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg {...icon} width={30} height={30}>
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
          </svg>
        </button>
        <span className="touch-hint" aria-live="polite">
          {hint(mode, tapMode)}
        </span>
      </div>
      <button type="button" className="touch-side" aria-label="Type a message" onClick={onType}>
        <svg {...icon}>
          <rect x="3" y="6" width="18" height="12" rx="2" />
          <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
        </svg>
      </button>
    </div>
  );
}
