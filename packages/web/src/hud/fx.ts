import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const NOISE = "▌▍▎▏█▓▒░<>/\\|+-=*#%&0123456789ABCDEF";

/**
 * One frame of the "scramble" that plays when a title changes: the first part (as much as `progress` says) is already the real
 * text, the rest is noise. Spaces stay spaces, so the shape of the line is kept. At 1 it is the text itself.
 */
export function scrambleFrame(text: string, progress: number, random: () => number = Math.random): string {
  const chars = [...text];
  if (progress >= 1) return text;
  const settled = Math.floor(chars.length * Math.max(0, progress));
  return chars.map((c, i) => (i < settled || c === " " ? c : NOISE[Math.floor(random() * NOISE.length)]!)).join("");
}

/** How many frames a scramble takes: enough to look like something, few enough for a long title to stay quick. */
export const scrambleSteps = (text: string): number => (text.length === 0 ? 0 : Math.min(24, Math.max(6, Math.ceil([...text].length / 2))));

/** The text that is shown for a title: it scrambles into place for about a third of a second whenever the title changes. */
export function useScramble(text: string, enabled: boolean): string {
  const [shown, setShown] = useState(text);
  const prev = useRef(text);
  useEffect(() => {
    if (!enabled || text === prev.current) {
      prev.current = text;
      setShown(text);
      return;
    }
    prev.current = text;
    const steps = scrambleSteps(text);
    if (steps === 0) {
      setShown(text);
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      i++;
      setShown(scrambleFrame(text, i / steps));
      if (i >= steps) clearInterval(id);
    }, 320 / steps);
    return () => clearInterval(id);
  }, [text, enabled]);
  return shown;
}

/** A ripple that spreads from where the pointer pressed, inside the pressed element. It removes itself. */
export function ripple(e: ReactPointerEvent<HTMLElement>): void {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const dot = document.createElement("span");
  dot.className = "hud-ripple";
  const size = Math.max(r.width, r.height) * 2;
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${e.clientX - r.left - size / 2}px`;
  dot.style.top = `${e.clientY - r.top - size / 2}px`;
  el.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove(), { once: true });
  setTimeout(() => dot.remove(), 900); // when animations are off there is no "animationend"
}
