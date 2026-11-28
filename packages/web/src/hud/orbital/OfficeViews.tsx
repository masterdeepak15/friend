import type { OfficeTicketView, OfficeWorkerView } from "@friend/protocol";
import { Avatar } from "../../people/ActivityList";
import type { Who } from "../../people/people";
import type { OfficeState } from "../../store";
import "./office-views.css";

const whoOf = (w: OfficeWorkerView): Who => ({ id: w.id, name: w.name, kind: "office", role: w.title });
const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

const COLUMNS: { status: OfficeTicketView["status"][]; title: string; tone: "cyan" | "green" | "orange" | "dim" }[] = [
  { status: ["doing"], title: "Being worked on", tone: "cyan" },
  { status: ["review", "blocked"], title: "Needs a look", tone: "orange" },
  { status: ["todo"], title: "Not started", tone: "dim" },
  { status: ["done"], title: "Done", tone: "green" },
];

/**
 * The tickets as a board: one column for what is being worked on, what needs a look, what has not started and what is done, each
 * ticket a card with its number, its project and whose it is (the worker's own colour and initials).
 */
export function TicketBoard({ office }: { office: OfficeState }) {
  if (!office.enabled) return <p className="ov-empty">The Office is switched off, so there are no workers or tickets. Turn it on in Settings, Office, then ask Friend to hire someone.</p>;
  const worker = (id: string | null) => office.workers.find((w) => w.id === id) ?? null;
  const total = office.tickets.length;
  const done = office.tickets.filter((t) => t.status === "done").length;
  return (
    <div className="ov-wrap">
      <div className="ov-summary" aria-label="Progress">
        <span className="ov-big">{done}<small> of {total} done</small></span>
        <div className="ov-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <i style={{ width: total ? `${(100 * done) / total}%` : "0%" }} />
        </div>
      </div>
      {total === 0 && <p className="ov-empty">No tickets yet. Ask Friend to give a worker something to do.</p>}
      <div className="ov-board">
        {COLUMNS.map((c) => {
          const items = office.tickets.filter((t) => c.status.includes(t.status)).sort((a, b) => b.id - a.id);
          return (
            <section key={c.title} className="ov-col" data-tone={c.tone} aria-label={c.title}>
              <h4>
                {c.title} <b>{items.length}</b>
              </h4>
              <div className="ov-cards">
                {items.slice(0, c.status.includes("done") ? 6 : 12).map((t) => {
                  const w = worker(t.workerId);
                  return (
                    <article key={t.id} className="ov-card" data-tone={c.tone}>
                      <div className="ov-card-top">
                        <span className="ov-id">#{t.id}</span>
                        <span className="ov-proj">{t.projectId}</span>
                        {t.status === "blocked" ? <span className="ov-tag">blocked</span> : null}
                      </div>
                      <p className="ov-title">{t.title}</p>
                      <div className="ov-who">{w ? (<><Avatar who={whoOf(w)} size={20} live={w.status === "running" || w.status === "starting"} /> <span>{w.name}</span></>) : <span className="ov-dim">{t.workerId ?? "nobody yet"}</span>}</div>
                    </article>
                  );
                })}
                {items.length === 0 && <p className="ov-dim">none</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The budget per worker: a bar for how much of its limit it has used (or, with no limit set, how much next to the busiest worker),
 * its tokens in figures, how full its session is, and the totals on top.
 */
export function BudgetBoard({ office }: { office: OfficeState }) {
  const workers = [...office.workers].sort((a, b) => b.tokens - a.tokens);
  if (workers.length === 0) return <p className="ov-empty">No workers yet. Ask Friend to hire one; its tokens appear here.</p>;
  const total = workers.reduce((n, w) => n + w.tokens, 0);
  const busiest = Math.max(1, ...workers.map((w) => w.tokens));
  const quota = office.quota.fiveHour;
  return (
    <div className="ov-wrap">
      <div className="ov-summary">
        <span className="ov-big">{k(total)}<small> tokens used by {workers.length} worker{workers.length === 1 ? "" : "s"}</small></span>
        {quota ? (
          <span className="ov-note">
            Your {Math.round(quota.utilization * 100)}% of the five-hour window is used
          </span>
        ) : null}
      </div>
      <ul className="ov-rows">
        {workers.map((w) => {
          const limited = w.budget !== null && w.budget > 0;
          const pct = limited ? Math.min(100, (100 * w.tokens) / w.budget!) : (100 * w.tokens) / busiest;
          const tone = limited && pct >= 90 ? "orange" : limited && pct >= 70 ? "warn" : "cyan";
          return (
            <li key={w.id} className="ov-row">
              <Avatar who={whoOf(w)} size={28} live={w.status === "running" || w.status === "starting"} />
              <div className="ov-rowbody">
                <div className="ov-rowtop">
                  <strong>{w.name}</strong>
                  <span className="ov-dim">{w.title}</span>
                  <span className="ov-fig">
                    {k(w.tokens)}
                    {limited ? ` of ${k(w.budget!)}` : ""}
                  </span>
                </div>
                <div className="ov-bar" data-tone={tone} role="progressbar" aria-label={`${w.name} budget`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                  <i style={{ width: `${Math.max(w.tokens > 0 ? 2 : 0, pct)}%` }} />
                </div>
                <div className="ov-sub">
                  {limited ? `${Math.round(pct)}% of its limit` : "no limit set (shown against the busiest worker)"}
                  {w.context ? ` · session ${Math.round((100 * w.context.tokens) / w.context.window)}% full` : ""}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
