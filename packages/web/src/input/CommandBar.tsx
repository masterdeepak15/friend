import { useEffect, useRef, useState, type CSSProperties } from "react";
import { filterCommands, parseSlash, unescapeSlash, type Slash } from "./commands";

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

/** The orbital screen draws the bar in its own strip: always there, in this place, with the assistant's name in its words. */
export interface HudBar {
  name: string;
  style: CSSProperties;
}

/**
 * Hidden until the owner taps the stage or starts typing; hides again after sending. On the orbital screen it is the strip at the
 * bottom instead (`hud`): always there, and sending or Esc only empties it, so the view never changes.
 * A line that starts with / is a command for this screen (see /help): it is never sent to the AI.
 */
export function CommandBar({ onSend, requestOpen, slash, onOpenChange, hud }: { onSend: (text: string) => void; requestOpen: number; slash?: Slash; onOpenChange?: (open: boolean) => void; hud?: HudBar }) {
  const always = !!hud;
  const [open, setOpen] = useState(false);
  const changed = useRef(onOpenChange);
  changed.current = onOpenChange;
  useEffect(() => changed.current?.(always ? false : open), [open, always]);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (requestOpen <= 0) return;
    if (always) input.current?.focus();
    else setOpen(true);
  }, [requestOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((!always && open) || isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "Space" || e.key === " ") return; // Space is hold-to-talk: it never starts a line of text
      if (e.key.length === 1) {
        e.preventDefault(); // the key is kept in state; don't let the browser insert it a second time
        setText(e.key);
        setSelected(0);
        if (always) input.current?.focus();
        else setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, always]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open && !always) return null;

  const choices = slash ? filterCommands(slash.commands, text) : [];
  const picked = choices[Math.min(selected, Math.max(choices.length - 1, 0))];
  const close = () => {
    setText("");
    setSelected(0);
    setOpen(false);
    if (always) input.current?.blur(); // so Space can talk again
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
      className={`command-bar${always ? " command-bar-hud" : ""}`}
      style={hud?.style}
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
        {...(always ? { "data-space-talks": "" } : {})}
        aria-label="Message"
        value={text}
        placeholder={hud ? `▸ ask ${hud.name} anything…` : "Talk to me… or type / for commands"}
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
