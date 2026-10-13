import { useCallback, useEffect, useRef, useState } from "react";
import { touch } from "../overlay/touch";

export interface UsageTotals {
  input: number;
  output: number;
  turns: number;
}
export interface UsageSummary {
  range: number;
  days: { day: string; input: number; output: number; turns: number }[];
  total: UsageTotals;
  byModel: (UsageTotals & { provider: string; model: string })[];
  bySource: (UsageTotals & { source: string })[];
}

export interface UsageApi {
  summary(days: number): Promise<UsageSummary>;
  clear(): Promise<{ removed: number }>;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  let body: { error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* no JSON body */
  }
  if (!res.ok) throw new Error(body.error ?? (res.status === 401 ? "Please sign in again." : `The request failed (${res.status}).`));
  return body as T;
}

export const httpUsageApi: UsageApi = {
  summary: (days) => call(`/api/usage?days=${days}`),
  clear: () => call("/api/usage", { method: "DELETE" }),
};

const RANGES = [7, 30, 90] as const;
const exact = (n: number) => n.toLocaleString("en-US");
/** 2,501,200 becomes 2.5M, 40,300 becomes 40.3K, small numbers stay as they are. */
export function short(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(n);
}
const SOURCE: Record<string, string> = { voice: "Voice", chat: "Chat", task: "Scheduled tasks", channel: "Messages (WhatsApp, Telegram…)", other: "Other" };

/** Tokens Friend used, day by day. Only counts are kept, never what was said. */
export function UsageTab({ api = httpUsageApi }: { api?: UsageApi }) {
  const [range, setRange] = useState<number>(7);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const alive = useRef(true);

  const load = useCallback(
    async (days: number) => {
      try {
        const s = await api.summary(days);
        if (alive.current) {
          setData(s);
          setError(null);
        }
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      }
    },
    [api],
  );

  useEffect(() => {
    alive.current = true;
    void load(range);
    return () => {
      alive.current = false;
    };
  }, [load, range]);

  const clear = async () => {
    try {
      const r = await api.clear();
      if (!alive.current) return;
      setNote(`Removed ${r.removed} saved counts.`);
      setSure(false);
      await load(range);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  };

  const peak = data ? Math.max(1, ...data.days.map((d) => d.input + d.output)) : 1;
  const empty = !!data && data.total.turns === 0;

  return (
    <>
      <div className="approval-actions" role="group" aria-label="How far back">
        {RANGES.map((r) => (
          <button key={r} type="button" style={touch} className={range === r ? "primary" : undefined} aria-pressed={range === r} onClick={() => setRange(r)}>
            {r} days
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}

      {data && (
        <>
          <div className="usage-totals">
            <div>
              <strong>{short(data.total.input)}</strong>
              <span>Sent to the model</span>
            </div>
            <div>
              <strong>{short(data.total.output)}</strong>
              <span>Written back</span>
            </div>
            <div>
              <strong>{data.total.turns}</strong>
              <span>Answers</span>
            </div>
          </div>

          {empty ? (
            <p className="auth-note">Nothing counted yet. Once Friend has answered, the tokens it used show up here.</p>
          ) : (
            <>
              <div className="usage-bars" aria-hidden={false}>
                {data.days.map((d) => {
                  const total = d.input + d.output;
                  return (
                    <div key={d.day} className="usage-bar-col">
                      <div role="img" aria-label={`${d.day}: ${exact(total)} tokens on ${d.turns} answers`} className="usage-bar" style={{ height: `${Math.max(total > 0 ? 4 : 1, Math.round((total / peak) * 100))}%` }} title={`${d.day}: ${exact(total)} tokens`} />
                      {data.days.length <= 31 && <span className="usage-bar-day">{d.day.slice(8)}</span>}
                    </div>
                  );
                })}
              </div>

              <table className="usage-table">
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Written</th>
                    <th scope="col">Answers</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.days].reverse().map((d) => (
                    <tr key={d.day}>
                      <th scope="row">{d.day}</th>
                      <td>{exact(d.input)}</td>
                      <td>{exact(d.output)}</td>
                      <td>{d.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <h4 className="plugins-heading">By model</h4>
              <ul className="usage-list">
                {data.byModel.map((m) => (
                  <li key={`${m.provider}/${m.model}`}>
                    <span>
                      {m.provider} / {m.model}
                    </span>
                    <span>
                      {short(m.input + m.output)} tokens · {m.turns} answers
                    </span>
                  </li>
                ))}
              </ul>

              <h4 className="plugins-heading">By where it came from</h4>
              <ul className="usage-list">
                {data.bySource.map((m) => (
                  <li key={m.source}>
                    <span>{SOURCE[m.source] ?? m.source}</span>
                    <span>
                      {short(m.input + m.output)} tokens · {m.turns} answers
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <p className="auth-note">Friend keeps counts only: the day, the model, and how many tokens. Never what was said. Counts older than a year are removed by themselves.</p>
      {note && <p className="auth-note">{note}</p>}
      <div className="approval-actions">
        {sure ? (
          <>
            <button type="button" style={touch} className="primary" onClick={() => void clear()}>
              Yes, clear them
            </button>
            <button type="button" style={touch} onClick={() => setSure(false)}>
              Keep them
            </button>
          </>
        ) : (
          <button type="button" style={touch} onClick={() => setSure(true)}>
            Clear saved counts
          </button>
        )}
      </div>
    </>
  );
}
