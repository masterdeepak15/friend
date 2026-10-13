import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { short } from "./UsageTab";

export interface ConversationInfo {
  /** The model keeps a conversation of its own (Claude Code does; the others are sent the recent history each time). */
  supported: boolean;
  contextTokens: number;
  autoCompact: boolean;
  compactAtTokens: number;
}

export interface ConversationApi {
  info(): Promise<ConversationInfo>;
  compact(): Promise<{ ok: boolean; message: string }>;
  /** Needs the PIN: Friend forgets the earlier conversation. */
  clear(pin: string): Promise<{ ok: boolean; message: string }>;
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
  if (!res.ok) throw new Error(body.error ?? (res.status === 401 ? "Please sign in again." : res.status === 403 ? "Incorrect PIN" : `The request failed (${res.status}).`));
  return body as T;
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const httpConversationApi: ConversationApi = {
  info: () => call("/api/conversation"),
  compact: () => call("/api/conversation/compact", json({})),
  clear: (pin) => call("/api/conversation/clear", json({ pin })),
};

const LIMITS = [50_000, 100_000, 200_000, 400_000, 800_000];

/**
 * Claude Code keeps one long conversation of its own, and re-reads all of it for every answer. This shows how big it is, tidies it
 * up (writes notes, starts a fresh one from them) or starts it over. The two settings are saved with the others; the buttons act now.
 */
export function ConversationSection({ api = httpConversationApi, autoCompact, limit, onChange }: { api?: ConversationApi; autoCompact: boolean; limit: number; onChange: (patch: { autoCompact?: boolean; compactAtTokens?: number }) => void }) {
  const [info, setInfo] = useState<ConversationInfo | null>(null);
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const i = await api.info();
      if (alive.current) setInfo(i);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const run = async (job: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await job();
      if (!alive.current) return;
      if (r.ok) setNote(r.message);
      else setError(r.message);
      setAsking(false);
      await refresh();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPin("");
      }
    }
  };

  if (asking) {
    return (
      <>
        <p className="auth-note">Enter your PIN to start fresh. Friend keeps its notes and memory, but forgets the earlier conversation.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void run(() => api.clear(pin))} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void run(() => api.clear(pin))}>
            Continue
          </button>
          <button
            type="button"
            style={touch}
            onClick={() => {
              setAsking(false);
              setPin("");
              setError(null);
            }}
          >
            Back
          </button>
        </div>
      </>
    );
  }

  const options = LIMITS.includes(limit) ? LIMITS : [...LIMITS, limit].sort((a, b) => a - b);
  return (
    <>
      <h4 className="plugins-heading">Conversation memory</h4>
      {info && !info.supported ? (
        <p className="auth-note">This model does not keep a conversation of its own: Friend sends it the recent messages each time, so there is nothing to tidy.</p>
      ) : (
        <>
          <p className="auth-note">{info ? `Claude is holding about ${short(info.contextTokens)} tokens of conversation${info.contextTokens === 0 ? " (it counts again after the next answer)" : ""}. It reads all of it for every answer, so a long one uses a lot of your plan.` : "Checking…"}</p>
          <label className="settings-check">
            <input type="checkbox" checked={autoCompact} onChange={(e) => onChange({ autoCompact: e.target.checked })} /> Tidy up by itself
          </label>
          <label className="settings-check" style={{ marginTop: 6 }}>
            When it grows past{" "}
            <select value={limit} onChange={(e) => onChange({ compactAtTokens: Number(e.target.value) })} disabled={!autoCompact}>
              {options.map((n) => (
                <option key={n} value={n}>
                  {short(n)} tokens
                </option>
              ))}
            </select>
          </label>
          <p className="auth-note">Tidying up writes short notes on what you were doing and starts a fresh conversation from them, before the next answer. Friend keeps its saved notes either way.</p>
          <div className="approval-actions">
            <button type="button" style={touch} disabled={busy || !info} onClick={() => void run(() => api.compact())}>
              Tidy up now
            </button>
            <button type="button" style={touch} disabled={busy || !info} onClick={() => setAsking(true)}>
              Start fresh
            </button>
          </div>
        </>
      )}
      {note && <p className="auth-note">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </>
  );
}
