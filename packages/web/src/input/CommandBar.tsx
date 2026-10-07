import { useEffect, useRef, useState } from "react";

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

/** Hidden until the owner taps the stage or starts typing; hides again after sending. */
export function CommandBar({ onSend, requestOpen }: { onSend: (text: string) => void; requestOpen: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (requestOpen > 0) setOpen(true);
  }, [requestOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (open || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1) {
        e.preventDefault(); // the key is kept in state; don't let the browser insert it a second time
        setText(e.key);
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const t = text.trim();
    if (t) onSend(t);
    setText("");
    setOpen(false);
  };

  return (
    <form
      className="command-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={input}
        aria-label="Message"
        value={text}
        placeholder="Talk to me…"
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setText("");
            setOpen(false);
          }
        }}
      />
      <button type="submit" aria-label="Send">
        ↵
      </button>
    </form>
  );
}
