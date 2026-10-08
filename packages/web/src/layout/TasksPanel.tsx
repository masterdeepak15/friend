import { useCallback, useEffect, useRef, useState } from "react";
import { Movable } from "./Movable";

export interface TaskItem {
  id: number;
  title: string;
  dueAt: number | null;
  repeat: "hourly" | "daily" | "weekly" | null;
}

export interface TasksSource {
  list(): Promise<TaskItem[]>;
}

export const httpTasks: TasksSource = {
  list: async () => {
    const res = await fetch("/api/tasks");
    if (!res.ok) throw new Error(res.status === 401 ? "Please sign in again." : `The request failed (${res.status}).`);
    return (await res.json()) as TaskItem[];
  },
};

/** "in 25 min", "today 5:00 PM", "tomorrow 9:00 AM", "overdue". */
export function formatDue(dueAt: number | null, now: number): { text: string; overdue: boolean } {
  if (dueAt === null) return { text: "to do", overdue: false };
  const diff = dueAt - now;
  if (diff < 0) return { text: "overdue", overdue: true };
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return { text: "now", overdue: false };
  if (mins < 60) return { text: `in ${mins} min`, overdue: false };
  const d = new Date(dueAt);
  const today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(d) - dayStart(today)) / 86_400_000);
  if (days === 0) return { text: `today ${time}`, overdue: false };
  if (days === 1) return { text: `tomorrow ${time}`, overdue: false };
  return { text: `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`, overdue: false };
}

/** The open tasks and reminders, soonest first. Read-only: ask Friend to add, finish or remove one. */
export function TasksPanel({ source = httpTasks, busy, onClose, now = Date.now }: { source?: TasksSource; busy: boolean; onClose: () => void; now?: () => number }) {
  const [items, setItems] = useState<TaskItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const l = await source.list();
      if (!alive.current) return;
      setItems(l);
      setError(null);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [source]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), 15_000);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  // a request that just finished may have added or finished a task
  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh]);

  const t = now();
  return (
    <Movable
      id="tasks"
      label="Schedule panel"
      className="panel panel-tasks glass"
      style={{ left: "2%", top: "12%" }}
      head={
        <>
          <span className="approval-title">Schedule</span>
          <button type="button" className="obj-close" aria-label="Close schedule" onClick={onClose}>
            ×
          </button>
        </>
      }
    >
      <div className="task-body">
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        {items && items.length === 0 && <p className="auth-note">Nothing scheduled. Say "remind me in 30 minutes to…".</p>}
        <ul className="task-list">
          {(items ?? []).map((i) => {
            const due = formatDue(i.dueAt, t);
            return (
              <li key={i.id} className={due.overdue ? "overdue" : undefined}>
                <span className="task-title">{i.title}</span>
                <span className="task-due">
                  {due.text}
                  {i.repeat ? ` · ${i.repeat}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Movable>
  );
}
