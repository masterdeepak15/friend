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
    // A button the mouse has just pressed keeps the focus, and Space on a focused button is "press it", not "talk": so after a mouse click the
    // focus is let go (a click made by the keyboard, which has no position, keeps it, and so does a field or a dialog that took the focus meanwhile).
    const clicked = (e: MouseEvent) => {
      if (e.detail === 0 || !(e.target instanceof Element)) return;
      const el = e.target.closest("button, [role=button], summary, a");
      if (!(el instanceof HTMLElement)) return;
      setTimeout(() => {
        if (document.activeElement === el) el.blur();
      }, 0);
    };
    document.addEventListener("click", clicked);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", lose);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("click", clicked);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", lose);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
}
