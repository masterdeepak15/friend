import { useEffect, useRef, useState } from "react";
import { filterCommands, parseSlash, unescapeSlash, type Slash } from "./commands";

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

/**
 * Hidden until the owner taps the stage or starts typing; hides again after sending.
 * A line that starts with / is a command for this screen (see /help): it is never sent to the AI.
 */
export function CommandBar({ onSend, requestOpen, slash, onOpenChange }: { onSend: (text: string) => void; requestOpen: number; slash?: Slash; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const changed = useRef(onOpenChange);
  changed.current = onOpenChange;
  useEffect(() => changed.current?.(open), [open]);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
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
        setSelected(0);
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

  const choices = slash ? filterCommands(slash.commands, text) : [];
  const picked = choices[Math.min(selected, Math.max(choices.length - 1, 0))];
  const close = () => {
    setText("");
    setSelected(0);
    setOpen(false);
  };

  const submit = () => {
    const t = text.trim();
    if (slash && parseSlash(t)) {
      // "/set" + Enter runs the highlighted match; "/camera on" runs as typed
      const typedArgs = /^\/\S*\s/.test(t);
      slash.run(!typedArgs && picked ? `/${picked.name}` : t);
    } else if (t) {
      onSend(unescapeSlash(t));
    }
    close();
  };

  return (
    <form
      className="command-bar"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {choices.length > 0 && (
        <ul className="slash-list" role="listbox" aria-label="Commands">
          {choices.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={c === picked}
              className={c === picked ? "on" : undefined}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the box
                setText(`/${c.name} `);
                input.current?.focus();
                setSelected(i);
              }}
            >
              <b>/{c.name}</b>
              {c.usage && <i>{c.usage}</i>}
              <span>{c.description}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={input}
        aria-label="Message"
        value={text}
        placeholder="Talk to me… or type / for commands"
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setSelected(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          } else if (choices.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setSelected((s) => (s + (e.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
          } else if (e.key === "Tab" && picked) {
            e.preventDefault();
            setText(`/${picked.name} `);
          }
        }}
      />
      <button type="submit" aria-label="Send">
        ↵
      </button>
    </form>
  );
}
