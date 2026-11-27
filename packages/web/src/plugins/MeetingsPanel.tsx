import { useCallback, useEffect, useRef, useState } from "react";
import { touch } from "../overlay/touch";
import { httpMeetingsApi, type MeetingView, type MeetingsApi } from "./meetingsApi";

const STATUS: Record<MeetingView["status"], string> = { scheduled: "scheduled", joining: "joining", lobby: "waiting to be let in", live: "in the meeting", ended: "ended", failed: "could not join", cancelled: "cancelled" };
const when = (t: number) => (t ? new Date(t).toLocaleString() : "");

/** The meetings the assistant has attended or will attend, with their notes. Meetings are started by asking Friend ("join this meeting"). */
export function MeetingsPanel({ api = httpMeetingsApi }: { api?: MeetingsApi }) {
  const [list, setList] = useState<MeetingView[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(() => {
    api
      .list()
      .then((l) => alive.current && setList(l))
      .catch((e: Error) => alive.current && setError(e.message));
  }, [api]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNote(r);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="pc-panel">
      <p className="auth-note">Tell Friend "join this meeting" with a Teams, Google Meet or Zoom link (and a time, if it is later). It asks you first. What people said is kept on this PC.</p>
      {list === null && !error && <p className="auth-note">Loading…</p>}
      {list?.length === 0 && <p className="auth-note">No meetings yet.</p>}
      {list?.map((m) => (
        <div key={m.id} className="pc-row">
          <p>
            <strong>{m.title || `Meeting ${m.id}`}</strong> · {STATUS[m.status]} · {m.host}
            {m.status === "scheduled" ? ` · ${when(m.startsAt)}` : m.startedAt ? ` · ${when(m.startedAt)}` : ""}
          </p>
          {m.detail && m.status !== "live" && <p className="auth-note">{m.detail}</p>}
          <div className="approval-actions">
            {(m.status === "live" || m.status === "lobby" || m.status === "joining" || m.status === "scheduled") && (
              <button type="button" style={touch} onClick={() => void act(() => api.leave(m.id))}>
                {m.status === "scheduled" ? "Cancel" : "Leave"}
              </button>
            )}
            {(m.summary || m.lines > 0) && (
              <button type="button" style={touch} onClick={() => setOpen(open === m.id ? null : m.id)}>
                {open === m.id ? "Hide notes" : "Notes"}
              </button>
            )}
            {m.status !== "live" && m.status !== "lobby" && m.status !== "joining" && (
              <button type="button" style={touch} onClick={() => void act(() => api.remove(m.id))}>
                Delete
              </button>
            )}
          </div>
          {open === m.id && (
            <div>
              <p>{m.summary || `No notes yet. ${m.lines} lines were heard.`}</p>
              {m.decisions.length > 0 && (
                <>
                  <p className="auth-note">Decisions</p>
                  <ul>
                    {m.decisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </>
              )}
              {m.tasks.length > 0 && (
                <>
                  <p className="auth-note">Tasks</p>
                  <ul>
                    {m.tasks.map((t, i) => (
                      <li key={i}>
                        {t.what}
                        {t.who ? ` (${t.who})` : ""}
                        {t.due ? ` by ${t.due}` : ""}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      ))}
      {note && <p className="auth-note">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </div>
  );
}
