import { useEffect, useRef, useState } from "react";
import { AttachButton, AttachChips } from "../attach/AttachControls";
import { FILES_ONLY_TEXT, useAttach, type AttachedFile } from "../attach/useAttach";
import type { ChatLine } from "../store";
import { Movable } from "./Movable";

/** The conversation, on request: what was said or typed, what Friend answered, and a box to type in. */
export function ChatPanel({ lines, live, onSend, onClose }: { lines: ChatLine[]; live: boolean; onSend: (text: string, files?: AttachedFile[]) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const attach = useAttach();
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [lines, live]);

  return (
    <Movable
      id="chat"
      label="Chat panel"
      className="panel panel-chat glass"
      style={{ left: "70%", top: "12%" }}
      head={
        <>
          <span className="approval-title">Chat</span>
          <button type="button" className="obj-close" aria-label="Close chat" onClick={onClose}>
            ×
          </button>
        </>
      }
    >
      <div className="chat-lines" role="log" aria-live="polite">
        {lines.length === 0 && <p className="auth-note">Nothing said yet. Talk to me, or type below.</p>}
        {lines.map((l, i) => (
          <p key={i} className={`chat-line chat-${l.role}`}>
            {l.text}
          </p>
        ))}
        <div ref={end} />
      </div>
      <AttachChips attach={attach} />
      <form
        className="chat-form"
        onDragOver={attach.handlers.onDragOver}
        onDrop={attach.handlers.onDrop}
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          const files = attach.ready;
          if ((!t && files.length === 0) || attach.busy) return; // a file still on its way is waited for
          if (files.length > 0) onSend(t || FILES_ONLY_TEXT, files);
          else onSend(t);
          attach.clear();
          setText("");
        }}
      >
        <input aria-label="Type to chat" data-space-talks="" value={text} placeholder="Type a message…" autoComplete="off" onChange={(e) => setText(e.target.value)} onPaste={attach.handlers.onPaste} />
        <AttachButton attach={attach} />
        <button type="submit" aria-label="Send message">
          ↵
        </button>
      </form>
    </Movable>
  );
}
