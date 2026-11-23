import { useRef } from "react";
import type { Attach } from "./useAttach";

/** The paperclip: opens the file chooser (several files at once). */
export function AttachButton({ attach }: { attach: Attach }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="attach-btn" aria-label="Attach files" title="Attach files" onClick={() => input.current?.click()}>
        📎
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        aria-label="Choose files to attach"
        onChange={(e) => {
          attach.add(Array.from(e.target.files ?? []));
          e.target.value = ""; // the same file can be chosen again
        }}
      />
    </>
  );
}

/** The files going with the message, each with a way to take it off again. */
export function AttachChips({ attach, float = false }: { attach: Attach; float?: boolean }) {
  if (attach.items.length === 0) return null;
  return (
    <ul className={`attach-chips${float ? " attach-float" : ""}`} aria-label="Attached files">
      {attach.items.map((i) => (
        <li key={i.key} data-state={i.state} title={i.error ?? i.name}>
          <span>{i.name}</span>
          {i.state === "uploading" && <i aria-label="Uploading">…</i>}
          {i.state === "failed" && <i role="alert">{i.error ?? "Failed"}</i>}
          <button type="button" aria-label={`Remove ${i.name}`} onClick={() => attach.remove(i.key)}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
