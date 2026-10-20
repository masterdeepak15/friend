import { useEffect, useRef } from "react";

export interface VoiceKeys {
  pressStart(): void;
  pressEnd(): void;
  blur(): void;
}

/** Elements where Space already means something; talking must not steal it. */
const IGNORED_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"]);
const IGNORED_ROLES = new Set(["button", "checkbox", "switch", "tab", "menuitem", "link", "radio", "option", "textbox", "combobox", "slider"]);
/** The orbital screen's message strip while it is empty: a space cannot start a message, so Space still means "talk" there. */
const emptyTalkBox = (t: EventTarget | null) => t instanceof HTMLInputElement && t.hasAttribute("data-space-talks") && t.value === "";
const ignored = (t: EventTarget | null) =>
  !emptyTalkBox(t) && t instanceof HTMLElement && (IGNORED_TAGS.has(t.tagName) || t.isContentEditable || IGNORED_ROLES.has(t.getAttribute("role") ?? ""));
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
    // Focus or visibility lost: close the microphone whether the recording was started by key or by pointer.
    const lose = () => {
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
