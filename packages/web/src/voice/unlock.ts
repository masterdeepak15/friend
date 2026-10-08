import { useEffect, useRef } from "react";

/**
 * Browsers keep audio silent until the page has had a click, tap or key press. Listening for any of them, anywhere on
 * the page, means the voice works even when the owner never held Space (typing, or a click on the PIN card).
 */
export function useAudioUnlock(voice: { unlock(): void }): void {
  const ref = useRef(voice);
  ref.current = voice;
  useEffect(() => {
    const on = () => ref.current.unlock();
    const events = ["pointerdown", "keydown", "touchend"] as const;
    for (const e of events) window.addEventListener(e, on, { passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, on);
    };
  }, []);
}
