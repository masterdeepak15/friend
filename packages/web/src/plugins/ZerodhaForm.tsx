import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import type { BrokersView } from "../settings/settingsApi";

export interface BrokerSchedule {
  id: number;
  name: string;
  broker: string;
  kind: "morning" | "close" | "custom";
  time: string;
  days: number[];
  channel: "telegram" | "whatsapp" | "sms";
  commentary: boolean;
  enabled: boolean;
  lastRunDay: string | null;
}
export interface BrokersStatus {
  zerodha: { installed: boolean; enabled: boolean; keySet: boolean; secretSet: boolean; loggedIn: boolean; expiresAt: number | null; detail: string };
  schedules: BrokerSchedule[];
  redirectUrl: string | null;
  timezone: string;
}
export interface NewSchedule {
  name: string;
  kind: "morning" | "close" | "custom";
  time: string;
  days: number[];
  channel: "telegram" | "whatsapp" | "sms";
}
export interface BrokersApi {
  status(): Promise<BrokersStatus>;
  /** `send` false: the login address to open here. `send` true: Friend sends it to the owner's phone. */
  loginLink(send: boolean): Promise<{ url?: string; sent?: boolean; via?: string }>;
  runNow(send?: boolean): Promise<{ text: string }>;
  addSchedule(s: NewSchedule, pin: string): Promise<void>;
  removeSchedule(id: number): Promise<void>;
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
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const httpBrokersApi: BrokersApi = {
  status: () => call<BrokersStatus>("/api/brokers"),
  loginLink: (send) => call("/api/brokers/zerodha/login-link", json("POST", { send })),
  runNow: (send) => call("/api/brokers/run", json("POST", { kind: "custom", send: send === true })),
  addSchedule: async (s, pin) => void (await call("/api/brokers/schedules", json("POST", { ...s, pin }))),
  removeSchedule: async (id) => void (await call(`/api/brokers/schedules/${id}`, { method: "DELETE" })),
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const CHANNELS = [
  ["telegram", "Telegram"],
  ["whatsapp", "WhatsApp"],
  ["sms", "SMS"],
] as const;
const LABEL: Record<string, string> = { telegram: "Telegram", whatsapp: "WhatsApp", sms: "SMS" };

/**
 * The Zerodha Configure fields: the Kite app's key and secret (write-only), the daily login, and the report schedules. Saving the
 * key and secret goes through the page's own Save (with the PIN); everything else here talks to the server directly.
 */
export function ZerodhaForm({
  view,
  setView,
  secret,
  setSecret,
  api = httpBrokersApi,
}: {
  view: BrokersView;
  setView: (v: BrokersView) => void;
  secret: string;
  setSecret: (s: string) => void;
  api?: BrokersApi;
}) {
  const [status, setStatus] = useState<BrokersStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pin, setPin] = useState("");
  const [draft, setDraft] = useState<NewSchedule>({ name: "Morning report", kind: "morning", time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram" });
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(() => api.status().then((s) => alive.current && setStatus(s)).catch(() => {}), [api]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const z = view.zerodha;
  const set = (patch: Partial<BrokersView>) => setView({ ...view, ...patch });
  const firstChannel = status?.schedules[0]?.channel ?? "telegram";

  const check = (): string | null => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time)) return "Write the time like 09:30 (HH:MM, 24 hour).";
    if (draft.days.length === 0) return "Choose at least one day.";
    if (!draft.name.trim()) return "Give the report a name.";
    return null;
  };
  const add = () =>
    run(async () => {
      await api.addSchedule({ ...draft, name: draft.name.trim() }, pin);
      setAdding(false);
      setConfirming(false);
      setPin("");
      await refresh();
    });

  return (
    <div className="settings-section">
      <p className="auth-note">
        Friend only reads your account. It cannot place orders. The figures you ask about pass through the AI model you chose (Claude from Anthropic, or Ollama on this PC), and a report you schedule goes to the messaging app you pick (Telegram or WhatsApp). Nothing else leaves this PC.
      </p>
      <p className="auth-note">
        {status?.redirectUrl ? (
          <>
            In your Kite Connect app, set the redirect URL to <code>{status.redirectUrl}</code>
          </>
        ) : (
          "No public address is set yet, so Zerodha cannot send you back to Friend after login (friend config set publicUrl https://…)."
        )}
      </p>
      <label className="settings-field">
        <span>API key</span>
        <input value={z.apiKey} autoComplete="off" onChange={(e) => set({ zerodha: { ...z, apiKey: e.target.value } })} style={touch} />
      </label>
      <label className="settings-field">
        <span>API secret</span>
        <input type="password" autoComplete="off" value={secret} placeholder={z.secretSet ? "A secret is saved. Type to replace it." : ""} onChange={(e) => setSecret(e.target.value)} style={touch} />
      </label>
      <label className="settings-field">
        <span>Time zone</span>
        <input value={view.timezone} onChange={(e) => set({ timezone: e.target.value })} style={touch} />
      </label>
      <label className="settings-field">
        <span>Days with no reports (one per line, YYYY-MM-DD)</span>
        <textarea value={view.skipDates.join("\n")} rows={3} onChange={(e) => set({ skipDates: e.target.value.split(/[\s,]+/).filter(Boolean) })} />
      </label>
      <label className="settings-field">
        <span>Remind me to log in (minutes before the first report, 0 = never)</span>
        <input type="number" min={0} max={120} value={view.loginReminderMinutes} onChange={(e) => set({ loginReminderMinutes: Number(e.target.value) })} style={touch} />
      </label>

      <h4 className="plugins-heading">Daily login</h4>
      <p className={status?.zerodha.loggedIn ? "auth-note" : "auth-note"}>{status?.zerodha.detail ?? "Checking…"}</p>
      <div className="approval-actions">
        <button
          type="button"
          style={touch}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await api.loginLink(false);
              if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
            })
          }
        >
          Open Zerodha login
        </button>
        <button
          type="button"
          style={touch}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await api.loginLink(true);
              setMessage(`The login link was sent to your phone${r.via ? ` (${LABEL[r.via] ?? r.via})` : ""}.`);
            })
          }
        >
          Send me the login link on {LABEL[firstChannel] ?? "Telegram"}
        </button>
      </div>

      <h4 className="plugins-heading">Reports</h4>
      {status && status.schedules.length === 0 && <p className="auth-note">No reports are scheduled.</p>}
      <ul className="plugins-list">
        {(status?.schedules ?? []).map((s) => (
          <li key={s.id}>
            <b>{s.name}</b>{" "}
            <small className="auth-note">
              {s.time}, {s.days.map((d) => DAYS[d - 1]).join(" ")} to {LABEL[s.channel]}
              {s.lastRunDay ? `, last sent ${s.lastRunDay}` : ""}
            </small>{" "}
            <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => { await api.removeSchedule(s.id); await refresh(); })}>
              Remove
            </button>
          </li>
        ))}
      </ul>

      {adding && !confirming && (
        <div className="settings-section">
          <label className="settings-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={touch} />
          </label>
          <label className="settings-field">
            <span>Kind</span>
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as NewSchedule["kind"] })} style={touch}>
              <option value="morning">Morning</option>
              <option value="close">Market close</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label className="settings-field">
            <span>Time (24 hour)</span>
            <input value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} placeholder="09:30" style={touch} />
          </label>
          <div className="settings-field" role="group" aria-label="Days">
            {DAYS.map((d, i) => (
              <label key={d} className="settings-check">
                <input type="checkbox" checked={draft.days.includes(i + 1)} onChange={(e) => setDraft({ ...draft, days: e.target.checked ? [...draft.days, i + 1].sort() : draft.days.filter((x) => x !== i + 1) })} />
                <span>{d}</span>
              </label>
            ))}
          </div>
          <label className="settings-field">
            <span>Send it on</span>
            <select value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value as NewSchedule["channel"] })} style={touch}>
              {CHANNELS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="approval-actions">
            <button
              type="button"
              style={touch}
              className="primary"
              onClick={() => {
                const problem = check();
                setError(problem);
                if (!problem) setConfirming(true);
              }}
            >
              Add report…
            </button>
            <button type="button" style={touch} onClick={() => { setAdding(false); setError(null); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {adding && confirming && (
        <>
          <p className="auth-note">Enter your PIN to add this report. It sends your portfolio figures to {LABEL[draft.channel]}.</p>
          <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void add()} />
          <div className="approval-actions">
            <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void add()}>
              Add report
            </button>
            <button type="button" style={touch} onClick={() => { setConfirming(false); setPin(""); }}>
              Back
            </button>
          </div>
        </>
      )}
      {!adding && (
        <div className="approval-actions">
          <button type="button" style={touch} onClick={() => { setAdding(true); setError(null); setMessage(null); }}>
            Add a report
          </button>
          <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => setReport((await api.runNow()).text))}>
            Show a report now
          </button>
          <button
            type="button"
            style={touch}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.runNow(true);
                setMessage("The report was sent to your phone.");
              })
            }
          >
            Send a report to my phone
          </button>
        </div>
      )}
      {report && <pre className="auth-note" style={{ whiteSpace: "pre-wrap" }}>{report}</pre>}
      {message && <p className="auth-note">{message}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </div>
  );
}
