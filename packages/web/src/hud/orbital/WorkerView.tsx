import type { ClientMsg, OfficeWorkerView } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";
import type { OfficeFeedLine } from "../../store";
import { Frame } from "./kit";
import { usingKeyboard } from "./modality";
import type { Rect } from "./ExpandedView";

export interface WorkerViewProps {
  worker: OfficeWorkerView;
  feed: OfficeFeedLine[];
  rect: Rect;
  send: (m: ClientMsg) => void;
  onClose: () => void;
}

/** One hired worker, large, in the middle of the screen: what it is doing, its feed (newest at the bottom), a Stop button and a box to say something to it. */
export function WorkerView({ worker, feed, rect, send, onClose }: WorkerViewProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (usingKeyboard()) closeRef.current?.focus();
  }, [worker.id]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight; // the newest line stays in view
  }, [feed.length]);
  const say = () => {
    const t = text.trim();
    if (!t) return;
    send({ type: "office.say", workerId: worker.id, text: t });
    setText("");
  };
  const active = worker.status === "starting" || worker.status === "running" || worker.status === "waiting";
  return (
    <Frame variant="chamfer" running title={worker.name} className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label={worker.name}>
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body ob-worker">
        <p className="ob-li">
          {worker.status}
          {worker.detail ? ` · ${worker.detail}` : ""}
        </p>
        <p className="ob-li ob-sub">Tokens {worker.tokens}{worker.budget ? ` of ${worker.budget}` : ""}</p>
        {worker.context ? (
          <p className="ob-li ob-sub" data-context="">
            Context {Math.round(worker.context.tokens / 1000)}k of {Math.round(worker.context.window / 1000)}k ({Math.round((worker.context.tokens / worker.context.window) * 100)}%)
          </p>
        ) : null}
        <div className="ob-worker-log" ref={logRef} aria-live="polite">
          {feed.length === 0 ? <p className="ob-li ob-sub">Nothing yet</p> : feed.map((l, i) => (
            <p key={`${l.at}-${i}`} data-feed-line="" data-kind={l.kind} className={`ob-li${l.kind === "tool" || l.kind === "result" ? " ob-live" : ""}`}>
              {l.text}
            </p>
          ))}
        </div>
      </div>
      <form
        className="ob-worker-say"
        onSubmit={(e) => {
          e.preventDefault();
          say();
        }}
      >
        <input type="text" aria-label={`Say to ${worker.name}`} placeholder={`Say to ${worker.name}`} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Send</button>
        <button type="button" className="ob-stop" disabled={!active} onClick={() => send({ type: "office.stop", workerId: worker.id })}>
          Stop
        </button>
        <button type="button" className="ob-stop" disabled={active} title="The worker writes where its work stands into OFFICE_NOTES.md, and its next ticket starts a clean session" onClick={() => send({ type: "office.tidy", workerId: worker.id })}>
          Tidy up
        </button>
        <button type="button" className="ob-stop" disabled={active} title="Only write the notes; the session goes on" onClick={() => send({ type: "office.tidy", workerId: worker.id, fresh: false })}>
          Notes only
        </button>
        <button type="button" className="ob-stop" onClick={() => (sure ? send({ type: "office.fire", workerId: worker.id }) : setSure(true))} onBlur={() => setSure(false)}>
          {sure ? "Confirm remove" : "Remove"}
        </button>
      </form>
    </Frame>
  );
}
