import { useEffect, useRef } from "react";

export interface VoiceKeys {
  pressStart(): void;
  pressEnd(): void;
  blur(): void;
}

const IGNORED_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"]);
const ignored = (t: EventTarget | null) =>
  t instanceof HTMLElement && (IGNORED_TAGS.has(t.tagName) || t.isContentEditable || t.getAttribute("role") === "button");
const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";

/** Hold Space to talk. Typing in a field, other keys and modifier combinations are left alone. */
export function useVoiceKeys(voice: VoiceKeys): void {
  const ref = useRef(voice);
  ref.current = voice;

  useEffect(() => {
    let held = false;
    const down = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (ignored(e.target) || ignored(document.activeElement)) return;
      e.preventDefault(); // no page scroll, no click on whatever has focus
      if (e.repeat || held) return;
      held = true;
      ref.current.pressStart();
    };
    const up = (e: KeyboardEvent) => {
      if (!isSpace(e) || !held) return;
      held = false;
      e.preventDefault();
      ref.current.pressEnd();
    };
    const lose = () => {
      if (!held) return;
      held = false;
      ref.current.blur();
    };
    const hidden = () => {
      if (document.hidden) lose();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", lose);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", lose);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
}
