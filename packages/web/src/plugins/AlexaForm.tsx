import { invocationNameProblem } from "@friend/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import type { AlexaView } from "../settings/settingsApi";

export interface AlexaStatus {
  installed: boolean;
  enabled: boolean;
  skillIdSet: boolean;
  invocationName: string;
  /** The address to give Amazon, or null while Friend has no public address. */
  endpoint: string | null;
  waiting: { short: string; deviceShort: string; locale: string; at: number }[];
  allowed: { short: string; name: string; addedAt: number }[];
}
export interface AlexaApi {
  status(): Promise<AlexaStatus>;
  allow(short: string, pin: string): Promise<void>;
  forget(short: string): Promise<void>;
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

export const httpAlexaApi: AlexaApi = {
  status: () => call<AlexaStatus>("/api/alexa"),
  allow: async (short, pin) => void (await call("/api/alexa/devices/allow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: short, pin }) })),
  forget: async (short) => void (await call(`/api/alexa/devices/${encodeURIComponent(short)}`, { method: "DELETE" })),
};

const SKILL_ID = /^amzn1\.ask\.skill\.[A-Za-z0-9-]{8,80}$/;
/** The first thing wrong with what was typed, or null. Blank is fine (it clears the setting). */
export function alexaProblem(v: Pick<AlexaView, "skillId" | "invocationName">): string | null {
  if (v.skillId.trim() && !SKILL_ID.test(v.skillId.trim())) return "A skill ID looks like amzn1.ask.skill.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (copy it from the console).";
  if (v.invocationName.trim()) return invocationNameProblem(v.invocationName);
  return null;
}

const FILES = [
  ["skill.json", "the skill's manifest (name, endpoint)"],
  ["en-IN.json", "the English (India) interaction model"],
  ["hi-IN.json", "the Hindi (India) interaction model"],
] as const;

const ago = (at: number): string => {
  const m = Math.max(0, Math.round((Date.now() - at) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/**
 * The Alexa Configure fields: the skill id and name (saved with the page's own PIN save), the address and files to paste into the
 * Alexa developer console, and the list of Echo devices (waiting to be allowed, and allowed).
 */
export function AlexaForm({ view, setView, api = httpAlexaApi }: { view: AlexaView; setView: (v: AlexaView) => void; api?: AlexaApi }) {
  const [status, setStatus] = useState<AlexaStatus | null>(null);
  const [allowing, setAllowing] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const problem = alexaProblem(view);
  const name = status?.invocationName || view.invocationName;
  const filesReady = !!status?.endpoint && !!status.invocationName;

  return (
    <div className="settings-section">
      <p className="auth-note">
        Friend talks to a skill of your own on Alexa. It is free: the skill stays in development mode in your own Amazon developer account and is never published, and only the Echo devices you allow can use it. Alexa can look things up and answer; anything that changes something is refused, or sent to your phone for a yes.
      </p>

      <h4 className="plugins-heading">In the Alexa developer console</h4>
      {status && status.endpoint ? (
        <p className="auth-note">
          Endpoint to paste (HTTPS, "My development endpoint has a certificate from a trusted certificate authority"): <code>{status.endpoint}</code>{" "}
          <button
            type="button"
            style={touch}
            onClick={() => {
              void navigator.clipboard?.writeText(status.endpoint!).then(() => setCopied(true), () => {});
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </p>
      ) : (
        status && <p className="auth-note">No public address is set yet, so Amazon cannot reach Friend (friend config set publicUrl https://…).</p>
      )}
      <p className="auth-note">If your address changes later, paste the new address into the console again. Nothing else needs to change.</p>
      {filesReady ? (
        <ul className="plugins-list">
          {FILES.map(([file, what]) => (
            <li key={file}>
              <a href={`/api/alexa/package/${file}`} download={file}>
                {file}
              </a>{" "}
              <small className="auth-note">{what}</small>
            </li>
          ))}
        </ul>
      ) : (
        status && status.endpoint && <p className="auth-note">Save an invocation name first; the files are made with it.</p>
      )}

      <label className="settings-field">
        <span>Skill ID</span>
        <input value={view.skillId} autoComplete="off" onChange={(e) => setView({ ...view, skillId: e.target.value })} placeholder="amzn1.ask.skill.…" style={touch} />
      </label>
      <label className="settings-field">
        <span>Invocation name</span>
        <input value={view.invocationName} autoComplete="off" onChange={(e) => setView({ ...view, invocationName: e.target.value })} placeholder="jarvis assistant" style={touch} />
      </label>
      {problem && (
        <p role="alert" className="auth-error">
          {problem}
        </p>
      )}

      <h4 className="plugins-heading">Echo devices</h4>
      {status && status.waiting.length === 0 && status.allowed.length === 0 && (
        <p className="auth-note">Say "Alexa, ask {name || "your invocation name"}" on your Echo once; it will appear here for you to allow.</p>
      )}
      <ul className="plugins-list">
        {(status?.waiting ?? []).map((w) => (
          <li key={w.short}>
            <b>Echo …{w.short}</b>{" "}
            <small className="auth-note">
              waiting ({w.locale}), asked {ago(w.at)}
            </small>{" "}
            <button type="button" style={touch} disabled={busy} onClick={() => { setAllowing(w.short); setPin(""); setError(null); }}>
              Allow
            </button>
          </li>
        ))}
        {(status?.allowed ?? []).map((a) => (
          <li key={a.short}>
            <b>{a.name}</b> <small className="auth-note">…{a.short}</small>{" "}
            <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => { await api.forget(a.short); await refresh(); })}>
              Forget
            </button>
          </li>
        ))}
      </ul>
      {allowing && (
        <>
          <p className="auth-note">Enter your PIN to allow Echo …{allowing}. Anyone who can speak to that Echo can then ask Friend things.</p>
          <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void run(async () => { await api.allow(allowing, pin); setAllowing(null); setPin(""); await refresh(); })} />
          <div className="approval-actions">
            <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void run(async () => { await api.allow(allowing, pin); setAllowing(null); setPin(""); await refresh(); })}>
              Allow this Echo
            </button>
            <button type="button" style={touch} onClick={() => { setAllowing(null); setPin(""); setError(null); }}>
              Back
            </button>
          </div>
        </>
      )}
      {error && !problem && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </div>
  );
}
