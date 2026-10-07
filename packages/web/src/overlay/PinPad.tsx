import { touch } from "./touch";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

export function PinPad({ pin, onChange }: { pin: string; onChange: (pin: string) => void }) {
  const add = (d: string) => onChange((pin + d).slice(0, 12));
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
