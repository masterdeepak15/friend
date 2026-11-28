import type { ClientMsg, CrewWorkerView } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";
import type { CrewFeedLine, CrewState } from "../store";
import "./crew.css";

export interface CrewDockProps {
  crew: CrewState;
  send: (m: ClientMsg) => void;
  /** Puts a line in the chat box (the tasks go through the assistant, never straight to a worker). */
  askAssistant?: (text: string) => void;
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};

type Tab = "now" | "talk" | "memory" | "tools";

/**
 * The crew on the screen: a small badge that says how many are working; opened, a list of the workers with what each is doing right now,
 * and for one worker its live feed, its own conversation, its own wiki and its tools. Read only: the workers are the assistant's, so a task
 * is given through her.
 */
export function CrewDock({ crew, send, askAssistant }: CrewDockProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("now");
  const [path, setPath] = useState("");
  const busy = crew.workers.filter((w) => w.status === "working").length;
  const worker = crew.workers.find((w) => w.id === picked) ?? null;
  const logRef = useRef<HTMLDivElement>(null);
  const feed: CrewFeedLine[] = worker ? (crew.feed[worker.id] ?? []) : [];

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight; // the newest line stays in view
  }, [feed.length, tab, picked]);

  // what a worker's talk and wiki say is asked for when that tab is open (and again when the worker has finished something)
  const lastAt = worker?.lastAt ?? 0;
  useEffect(() => {
    if (!worker) return;
    if (tab === "talk") send({ type: "crew.view", workerId: worker.id, what: "history" });
    if (tab === "memory") send({ type: "crew.view", workerId: worker.id, what: "memory", ...(path ? { path } : {}) });
  }, [worker?.id, tab, path, lastAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (crew.workers.length === 0) return null;
  const data = (what: "history" | "memory") => (worker ? crew.data[`${worker.id}:${what}`] : undefined);

  return (
    <div className="cr-dock" data-open={open}>
      <button type="button" className="cr-badge" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cr-dot" data-working={busy > 0} aria-hidden />
        CREW · {busy > 0 ? `${busy} working` : `${crew.workers.length}`}
      </button>
      {open && (
        <div className="cr-panel" role="dialog" aria-label="Crew">
          <ul className="cr-list" aria-label="Crew workers">
            {crew.workers.map((w) => (
              <WorkerRow key={w.id} w={w} last={(crew.feed[w.id] ?? []).at(-1)} on={w.id === picked} onPick={() => { setPicked(w.id); setTab("now"); setPath(""); }} />
            ))}
          </ul>
          {worker && (
            <section className="cr-detail" aria-label={worker.name}>
              <header className="cr-head">
                <strong>{worker.name}</strong> <span className="cr-sub">{worker.role}</span>
                <button type="button" className="cr-x" aria-label="Close worker" onClick={() => setPicked(null)}>×</button>
              </header>
              <nav className="cr-tabs" role="tablist">
                {(["now", "talk", "memory", "tools"] as Tab[]).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} className="cr-tab" onClick={() => setTab(t)}>
                    {t === "now" ? "Now" : t === "talk" ? "Talk" : t === "memory" ? "Memory" : "Tools"}
                  </button>
                ))}
              </nav>
              {tab === "now" && (
                <div className="cr-log" ref={logRef} aria-live="polite">
                  {feed.length === 0 ? <p className="cr-sub">Nothing yet. Ask {askAssistant ? "the assistant" : "her"} to give {worker.name} a task.</p> : feed.map((l, i) => (
                    <p key={`${l.at}-${i}`} data-kind={l.kind} className="cr-line">
                      <time>{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time> {l.text}
                    </p>
                  ))}
                </div>
              )}
              {tab === "talk" && <pre className="cr-log cr-pre">{data("history")?.text ?? "Loading…"}</pre>}
              {tab === "memory" && (
                <div>
                  <form className="cr-path" onSubmit={(e) => e.preventDefault()}>
                    <input aria-label="Note or folder" placeholder="folder/note.md (empty: the index)" value={path} onChange={(e) => setPath(e.target.value)} />
                  </form>
                  <pre className="cr-log cr-pre">{data("memory")?.text ?? "Loading…"}</pre>
                </div>
              )}
              {tab === "tools" && (
                <ul className="cr-tools">
                  {worker.tools.length === 0 ? <li className="cr-sub">No tools yet (its own notes only).</li> : worker.tools.map((t) => <li key={t}><code>{t}</code></li>)}
                </ul>
              )}
              {askAssistant && (
                <button type="button" className="cr-ask" onClick={() => askAssistant(`Ask ${worker.name} to `)}>
                  Ask the assistant to give {worker.name} a task
                </button>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function WorkerRow({ w, last, on, onPick }: { w: CrewWorkerView; last: CrewFeedLine | undefined; on: boolean; onPick: () => void }) {
  return (
    <li>
      <button type="button" className="cr-row" aria-pressed={on} data-working={w.status === "working"} onClick={onPick}>
        <span className="cr-dot" data-working={w.status === "working"} aria-hidden />
        <span className="cr-name">{w.name}</span>
        <span className="cr-sub">{w.role}</span>
        <span className="cr-now">{w.status === "working" ? `working ${w.since ? ago(w.since) : ""} · ${last && last.kind !== "task" ? last.text : w.task}` : w.lastAt ? `idle · last ${ago(w.lastAt)} ago` : "idle"}</span>
      </button>
    </li>
  );
}
