import { useEffect, useRef } from "react";
import { touch } from "./touch";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MAX = 12;
/** A PIN has at least this many digits, so Enter does nothing before then. */
const MIN = 6;

const isTextField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

/**
 * Digits, Backspace and Enter on the keyboard work as well as the on-screen keys. The keys are taken before anything else
 * on the page sees them (so typing a PIN never opens the message bar), but never while a text box has the focus.
 */
export function PinPad({ pin, onChange, onSubmit }: { pin: string; onChange: (pin: string) => void; onSubmit?: () => void }) {
  const add = (d: string) => onChange((pin + d).slice(0, MAX));

  // always the newest values, without re-attaching the listener on every key
  const live = useRef({ pin, onChange, onSubmit });
  live.current = { pin, onChange, onSubmit };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) return;
      const { pin: p, onChange: change, onSubmit: submit } = live.current;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        change((p + e.key).slice(0, MAX));
      } else if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        change(p.slice(0, -1));
      } else if (e.key === "Enter" && submit) {
        e.preventDefault();
        e.stopPropagation();
        if (p.length >= MIN) submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="pinpad">
      <div className="pin-dots" data-testid="pin-dots" aria-label="PIN entered" aria-live="polite">
        {"•".repeat(pin.length)}
      </div>
      <div className="pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" style={touch} aria-label={k} onClick={() => add(k)}>
            {k}
          </button>
        ))}
        <span />
        <button type="button" style={touch} aria-label="0" onClick={() => add("0")}>
          0
        </button>
        <button type="button" style={touch} aria-label="Backspace" onClick={() => onChange(pin.slice(0, -1))}>
          ⌫
        </button>
      </div>
    </div>
  );
}
