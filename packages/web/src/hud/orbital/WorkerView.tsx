import type { ClientMsg, OfficeWorkerView } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";
import { ActivityList, Avatar } from "../../people/ActivityList";
import type { Act, Who } from "../../people/people";
import type { OfficeFeedLine } from "../../store";
import { Frame } from "./kit";
import "./office-views.css";
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
  const who: Who = { id: worker.id, name: worker.name, kind: "office", role: worker.title };
  const acts: Act[] = feed.map((l) => ({ who, at: l.at, kind: l.kind, text: l.text }));
  const active = worker.status === "starting" || worker.status === "running" || worker.status === "waiting";
  return (
    <Frame variant="chamfer" running title={worker.name} className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label={worker.name}>
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body ob-worker">
        <div className="ow-head">
          <Avatar who={who} size={40} live={active} />
          <div className="ow-id">
            <strong>{worker.name}</strong>
            <span className="ow-sub">{worker.title || "Office worker"}{worker.capabilities ? ` · ${worker.capabilities}` : ""}</span>
          </div>
          <span className="ow-status" data-status={worker.status}>
            {worker.status}
          </span>
        </div>
        {worker.detail ? <p className="ob-li ow-now">{worker.detail}</p> : null}
        <div className="ow-meters">
          <div className="ow-meter">
            <span className="ow-sub">Tokens</span>
            <b>{worker.tokens}{worker.budget ? ` of ${worker.budget}` : ""}</b>
            {worker.budget ? <div className="ow-track"><i style={{ width: `${Math.min(100, (100 * worker.tokens) / worker.budget)}%` }} /></div> : null}
          </div>
          {worker.context ? (
            <div className="ow-meter" data-context="">
              <span className="ow-sub">Session</span>
              <b>Context {Math.round(worker.context.tokens / 1000)}k of {Math.round(worker.context.window / 1000)}k ({Math.round((worker.context.tokens / worker.context.window) * 100)}%)</b>
              <div className="ow-track"><i style={{ width: `${Math.min(100, (100 * worker.context.tokens) / worker.context.window)}%` }} /></div>
            </div>
          ) : null}
        </div>
        {worker.skills?.length || worker.mcp?.length ? (
          <p className="ob-li ob-sub" data-grants="">
            {worker.skills?.length ? `Skills: ${worker.skills.join(", ")}` : ""}
            {worker.skills?.length && worker.mcp?.length ? " · " : ""}
            {worker.mcp?.length ? `Tools: ${worker.mcp.join(", ")}` : ""}
          </p>
        ) : null}
        <div className="ob-worker-log ow-log" ref={logRef}>
          <ActivityList items={acts} live={active ? [worker.id] : []} legend={false} empty="Nothing yet" />
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
