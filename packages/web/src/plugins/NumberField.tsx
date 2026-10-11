import { useEffect, useState } from "react";
import { touch } from "../overlay/touch";

/**
 * A labelled number box that can be cleared and retyped. The number is passed on as soon as what is typed is a number; if the box is
 * left empty or unreadable it goes back to the last good number when you leave it.
 */
export function NumberField({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : String(value)));
  }, [value]);
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() !== "" && Number.isFinite(Number(e.target.value))) onChange(Number(e.target.value));
        }}
        onBlur={() => setText(String(value))}
        style={touch}
      />
    </label>
  );
}
