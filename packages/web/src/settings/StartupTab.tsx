import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";

export interface UpdateInfo {
  current: string;
  latest: string | null;
  checkedAt: number | null;
  available: boolean;
  applying: boolean;
  /** Friend runs in the background, so it can restart itself to update. */
  canApply: boolean;
  error: string | null;
}

export interface SystemInfo {
  version: string;
  auto: boolean;
  update: UpdateInfo;
  autostart: { supported: boolean; enabled: boolean; kind: string };
}

export interface SystemApi {
  info(): Promise<SystemInfo>;
  /** Asks npm now. */
  check(): Promise<UpdateInfo>;
  /** Installs the newest version and restarts Friend. Needs the PIN. */
  update(pin: string): Promise<{ ok: boolean; message: string }>;
  /** Needs the PIN. */
  setAutostart(enabled: boolean, pin: string): Promise<{ ok: boolean; message: string; status: SystemInfo["autostart"] }>;
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

export const httpSystemApi: SystemApi = {
  info: () => call("/api/system"),
  check: () => call("/api/system/update/check", json({})),
  update: (pin) => call("/api/system/update/apply", json({ pin })),
  setAutostart: (enabled, pin) => call("/api/system/autostart", json({ enabled, pin })),
};

type Ask = { kind: "autostart"; enabled: boolean } | { kind: "update" };

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Starting Friend when the computer starts, and updating it. The switch for updating by itself is a setting like the others (saved
 * with Save); what happens on this computer (the start-up entry, an update now) is done here, each with the PIN.
 */
export function StartupTab({ api = httpSystemApi, auto, onAuto, pollMs = 0 }: { api?: SystemApi; auto: boolean; onAuto: (on: boolean) => void; pollMs?: number }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [asking, setAsking] = useState<Ask | null>(null);
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
    const t = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [refresh, pollMs]);

  const run = async () => {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      const r = asking.kind === "autostart" ? await api.setAutostart(asking.enabled, pin) : await api.update(pin);
      if (!alive.current) return;
      setNote(r.message);
      setAsking(null);
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

  const check = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const u = await api.check();
      if (alive.current) setInfo((cur) => (cur ? { ...cur, update: u } : cur));
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (asking) {
    return (
      <>
        <p className="auth-note">{asking.kind === "update" ? "Enter your PIN to update Friend now. It restarts in a moment." : asking.enabled ? "Enter your PIN to start Friend by itself when this computer starts." : "Enter your PIN to stop starting Friend with this computer."}</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void run()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void run()}>
            Continue
          </button>
          <button
            type="button"
            style={touch}
            onClick={() => {
              setAsking(null);
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

  const u = info?.update;
  return (
    <>
      <h4 className="plugins-heading">Start with the computer</h4>
      {info &&
        (info.autostart.supported ? (
          <>
            <p className="auth-note">{info.autostart.enabled ? "Friend starts by itself when you sign in to this computer, so you never have to start it after a restart." : "Friend does not start by itself yet: after a restart you start it yourself."}</p>
            <div className="approval-actions">
              <button type="button" style={touch} className={info.autostart.enabled ? undefined : "primary"} disabled={busy} onClick={() => setAsking({ kind: "autostart", enabled: !info.autostart.enabled })}>
                {info.autostart.enabled ? "Stop starting Friend with this computer" : "Start Friend when this computer starts"}
              </button>
            </div>
          </>
        ) : (
          <p className="auth-note">Starting Friend by itself is not supported on this computer.</p>
        ))}

      <h4 className="plugins-heading">Updates</h4>
      {info && u && (
        <>
          <p className="auth-note">
            Friend {info.version}.{" "}
            {u.applying ? `Updating Friend to ${u.latest ?? "the newest version"}…` : u.available ? `Friend ${u.latest} is available.` : u.latest ? "Up to date." : "Not checked yet."}
            {u.checkedAt ? ` (looked at ${clock(u.checkedAt)})` : ""}
          </p>
          {u.error && <p className="auth-error">{u.error}</p>}
          {u.available && !u.canApply && !u.applying && <p className="auth-note">This Friend is running in a terminal, so it cannot restart itself. Close it and run: friend upgrade</p>}
          <div className="approval-actions">
            <button type="button" style={touch} disabled={busy || u.applying} onClick={() => void check()}>
              Check for updates
            </button>
            {u.available && u.canApply && !u.applying && (
              <button type="button" style={touch} className="primary" disabled={busy} onClick={() => setAsking({ kind: "update" })}>
                Update now
              </button>
            )}
          </div>
        </>
      )}
      <label className="settings-check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={auto} onChange={(e) => onAuto(e.target.checked)} /> Update Friend by itself
      </label>
      <p className="auth-note">Looks for a newer Friend when it starts, then every few hours, and installs it while Friend is not busy. Switch it off to update only when you press Update now (or run friend upgrade).</p>
      {note && <p className="auth-note">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </>
  );
}
