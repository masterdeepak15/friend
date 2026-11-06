import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import type { AuditSettings } from "./settingsApi";
import { AuditLocked, httpAuditApi, type ActorKind, type AuditApi, type AuditFilter, type AuditNode, type AuditRow, type AuditStatus, type ExportFormat, type KindGroup, type Outcome, type VerifyResult } from "./auditApi";

const WHEN: { id: string; label: string; ms: number | null }[] = [
  { id: "1h", label: "Last hour", ms: 3600_000 },
  { id: "24h", label: "Last 24 hours", ms: 24 * 3600_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 3600_000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * 3600_000 },
  { id: "all", label: "Everything kept", ms: null },
];
const WHO: ActorKind[] = ["owner", "assistant", "worker", "system", "outsider"];
const KIND: KindGroup[] = ["approvals", "tools", "workers", "logins", "messages", "settings", "system", "other"];
const RESULT: Outcome[] = ["refused", "failed", "waiting", "done", "started"];
const CLIP = 400;
const PAGE = 100;

const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);

/** A value from the log, shown as text (never as markup), cut when long. */
function Clip({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  if (text.length <= CLIP || all) return <>{text}</>;
  return (
    <>
      {text.slice(0, CLIP)}…{" "}
      <button type="button" className="link-button" onClick={() => setAll(true)}>
        show more
      </button>
    </>
  );
}

function RequestTree({ nodes }: { nodes: AuditNode[] }) {
  return (
    <ol className="audit-tree">
      {nodes.map((n) => (
        <li key={n.row.id}>
          <span>
            #{n.row.id} {when(n.row.ts)} {n.row.actorKind} {n.row.actorId} <b>{n.row.kind}</b> {n.row.target} {n.row.outcome && `[${n.row.outcome}]`}
          </span>
          {n.children.length > 0 && <RequestTree nodes={n.children} />}
        </li>
      ))}
    </ol>
  );
}

/** What Maya, the workers and the owner did: filters, one request's whole story, the chain check, and exports. Opens with the PIN. */
export function AuditTab({ api: given, settings, onSettings }: { api?: AuditApi; settings?: AuditSettings; onSettings?: (p: Partial<AuditSettings>) => void }) {
  const api = useRef(given ?? httpAuditApi()).current;
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState<{ when: string; who: ActorKind | ""; actorId: string; kind: KindGroup | ""; result: Outcome | ""; q: string }>({ when: "24h", who: "", actorId: "", kind: "", result: "", q: "" });
  const [view, setView] = useState<"all" | "attention">("all");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [counts, setCounts] = useState({ total: 0, refused: 0, failed: 0 });
  const [status, setStatus] = useState<AuditStatus | null>(null);
  const [chain, setChain] = useState<VerifyResult | null>(null);
  const [tree, setTree] = useState<{ id: string; nodes: AuditNode[] } | null>(null);
  const seq = useRef(0);

  const locked = useCallback((e: unknown): boolean => {
    if (e instanceof AuditLocked) {
      setUnlocked(false);
      setRows([]);
      setTree(null);
      setError(null);
      return true;
    }
    setError((e as Error).message);
    return false;
  }, []);

  const filter = (extra: Partial<AuditFilter> = {}): AuditFilter => {
    const w = WHEN.find((x) => x.id === filters.when);
    return {
      ...(w?.ms ? { from: Date.now() - w.ms } : {}),
      ...(filters.who ? { actorKind: filters.who } : {}),
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.kind ? { group: filters.kind } : {}),
      ...(filters.result ? { outcome: filters.result } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      limit: PAGE,
      ...extra,
    };
  };

  useEffect(() => {
    if (!unlocked) return;
    const mine = ++seq.current;
    void (async () => {
      try {
        if (view === "attention") {
          const r = await api.attention();
          if (mine === seq.current) {
            setRows(r);
            setCounts({ total: r.length, refused: r.filter((x) => x.outcome === "refused").length, failed: r.filter((x) => x.outcome === "failed").length });
            setError(null);
          }
          return;
        }
        const r = await api.search(filter());
        if (mine === seq.current) {
          setRows(r.rows);
          setCounts(r.counts);
          setError(null);
        }
      } catch (e) {
        if (mine === seq.current) locked(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked, filters, view, api]);

  useEffect(() => {
    if (!unlocked) return;
    api.status().then(setStatus, (e) => void locked(e));
  }, [unlocked, api, locked]);

  const unlock = async () => {
    if (busy || pin.length < 6) return;
    setBusy(true);
    try {
      await api.unlock(pin);
      setUnlocked(true);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPin("");
      setBusy(false);
    }
  };

  if (!unlocked) {
    return (
      <div className="settings-section">
        <p className="auth-note">Enter your PIN to open the audit log. It shows what you, your assistant and your workers did, and stays open for a few minutes.</p>
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <PinPad pin={pin} onChange={setPin} onSubmit={() => void unlock()} />
        <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void unlock()}>
          Open
        </button>
      </div>
    );
  }

  const set = (p: Partial<typeof filters>) => {
    setView("all");
    setFilters({ ...filters, ...p });
  };
  const follow = async (id: string) => {
    try {
      setTree({ id, nodes: await api.tree(id) });
    } catch (e) {
      locked(e);
    }
  };
  const more = async () => {
    try {
      const last = rows.at(-1);
      const r = await api.search(filter({ before: last?.id }));
      setRows([...rows, ...r.rows]);
    } catch (e) {
      locked(e);
    }
  };
  const download = async (format: ExportFormat) => {
    try {
      await api.download(filter({ limit: undefined }), format);
    } catch (e) {
      locked(e);
    }
  };

  return (
    <>
      <div className="approval-actions" role="group" aria-label="Quick views">
        <button type="button" style={touch} className={view === "all" && !filters.actorId ? "primary" : undefined} onClick={() => (setView("all"), setFilters({ when: "24h", who: "", actorId: "", kind: "", result: "", q: "" }))}>
          Today
        </button>
        <button type="button" style={touch} className={view === "attention" ? "primary" : undefined} onClick={() => setView("attention")}>
          Needs attention
        </button>
        <button type="button" style={touch} onClick={() => set({ kind: "approvals", actorId: "", who: "" })}>
          Approvals
        </button>
        {(status?.workers ?? []).map((w) => (
          <button key={w.id} type="button" style={touch} className={filters.actorId === w.id ? "primary" : undefined} onClick={() => set({ who: "worker", actorId: w.id, kind: "" })}>
            {w.name}
          </button>
        ))}
      </div>

      <div className="of-grid">
        <label>
          When
          <select value={filters.when} onChange={(e) => set({ when: e.target.value })}>
            {WHEN.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Who
          <select value={filters.who} onChange={(e) => set({ who: e.target.value as ActorKind | "", actorId: "" })}>
            <option value="">Everyone</option>
            {WHO.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value as KindGroup | "" })}>
            <option value="">All kinds</option>
            {KIND.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label>
          Result
          <select value={filters.result} onChange={(e) => set({ result: e.target.value as Outcome | "" })}>
            <option value="">Any result</option>
            {RESULT.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label>
          Search
          <input type="text" value={filters.q} maxLength={200} onChange={(e) => set({ q: e.target.value })} />
        </label>
      </div>

      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <p className="auth-note">
        {counts.total} entries, {counts.refused} refused, {counts.failed} failed
      </p>

      <table className="usage-table audit-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Time (UTC)</th>
            <th>Who</th>
            <th>What</th>
            <th>Target</th>
            <th>Result</th>
            <th>Details</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{when(r.ts)}</td>
              <td>
                {r.actorKind} {r.actorId}
              </td>
              <td>{r.kind}</td>
              <td>
                <Clip text={r.target} />
              </td>
              <td>{r.outcome}</td>
              <td>
                <Clip text={JSON.stringify(r.detail)} />
              </td>
              <td>
                {r.requestId && (
                  <button type="button" className="link-button" onClick={() => void follow(r.requestId!)}>
                    Follow this request
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view === "all" && rows.length >= PAGE && (
        <button type="button" style={touch} onClick={() => void more()}>
          Load more
        </button>
      )}

      {tree && (
        <section aria-label={`Request ${tree.id}`} className="settings-section">
          <h3>Request {tree.id}</h3>
          {tree.nodes.length ? <RequestTree nodes={tree.nodes} /> : <p className="auth-note">Nothing else was recorded for this request.</p>}
          <button type="button" className="link-button" onClick={() => setTree(null)}>
            Close
          </button>
        </section>
      )}

      <div className="approval-actions">
        <button type="button" style={touch} onClick={() => void api.verify().then(setChain, (e) => void locked(e))}>
          Verify chain
        </button>
        {(["csv", "html", "json"] as const).map((f) => (
          <button key={f} type="button" style={touch} onClick={() => void download(f)}>
            {f === "csv" ? "CSV" : f === "html" ? "Report (HTML)" : "JSON"}
          </button>
        ))}
      </div>
      {chain && <p className={chain.ok ? "auth-note" : "auth-error"}>{chain.ok ? `Chain OK (${chain.rows} chained entries).` : `Chain broken at entry ${chain.brokenAt} (${chain.reason}). Something changed the log.`}</p>}

      {settings && onSettings && (
        <div className="settings-section" aria-label="Audit settings">
          <h3>Keeping the log</h3>
          <div className="of-grid">
            <label>
              Days kept (0 keeps everything)
              <input type="number" min={0} max={3650} value={settings.keepDays} onChange={(e) => onSettings({ keepDays: Math.min(3650, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
            </label>
            <label>
              Daily seal at (empty turns it off)
              <input type="text" value={settings.sealAt} placeholder="09:00" maxLength={5} onChange={(e) => onSettings({ sealAt: e.target.value })} />
            </label>
            <label>
              Minutes open after the PIN
              <input type="number" min={1} max={120} value={settings.unlockMinutes} onChange={(e) => onSettings({ unlockMinutes: Math.min(120, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={settings.archive} onChange={(e) => onSettings({ archive: e.target.checked })} />
              <span>Keep a checkable archive of what is removed</span>
            </label>
          </div>
          <small className="auth-note">Changing these needs your PIN when you save. The seal is a one-line fingerprint of the log sent to your phone once a day, so the log cannot be rewritten without you noticing.</small>
        </div>
      )}
      {status && (
        <p className="auth-note">
          {status.rows} entries kept ({status.keepDays ? `${status.keepDays} days` : "no limit"}). {status.lastSeal ? `Last seal: ${when(status.lastSeal.at)} UTC.` : "No seal has been made yet."}
        </p>
      )}
    </>
  );
}
