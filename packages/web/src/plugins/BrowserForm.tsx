import { useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpSettingsApi, type SettingsApi } from "../settings/settingsApi";
import { NumberField } from "./NumberField";

interface Saved {
  chromePath: string;
  timeoutSec: number;
  maxChars: number;
}

/**
 * The Configure page of the safe browser: which Chrome or Edge to use (empty: Friend finds one), how long a page may take, and how much of
 * its text the assistant gets. Saved with the owner's PIN, like every other setting.
 */
export function BrowserForm({ api = httpSettingsApi, found }: { api?: SettingsApi; found: string }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [path, setPath] = useState("");
  const [timeoutSec, setTimeoutSec] = useState(20);
  const [maxChars, setMaxChars] = useState(12000);
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const adopt = (b: Saved) => {
    setSaved(b);
    setPath(b.chromePath);
    setTimeoutSec(b.timeoutSec);
    setMaxChars(b.maxChars);
  };

  useEffect(() => {
    alive.current = true;
    api
      .get()
      .then((s) => alive.current && s.browser && adopt(s.browser))
      .catch((e: Error) => alive.current && setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [api]);

  const browser: Record<string, unknown> = {};
  if (saved && path.trim() !== saved.chromePath) browser.chromePath = path.trim();
  if (saved && timeoutSec !== saved.timeoutSec) browser.timeoutSec = timeoutSec;
  if (saved && maxChars !== saved.maxChars) browser.maxChars = maxChars;
  const dirty = Object.keys(browser).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.save({ browser }, pin);
      if (!alive.current) return;
      if (r.settings.browser) adopt(r.settings.browser);
      setAsking(false);
      setNote("Saved.");
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
        <p className="auth-note">Enter your PIN to save these changes.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void save()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void save()}>
            Save
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

  return (
    <>
      <p className="auth-note">{found ? `Friend will use: ${found}` : "Friend has not found Chrome or Edge on this PC."}</p>
      <label className="settings-field">
        <span>Browser program (optional)</span>
        <input aria-label="Browser program" value={path} placeholder="Leave empty to find Chrome or Edge by itself" onChange={(e) => setPath(e.target.value)} />
        <small className="auth-note">A full path to chrome.exe, msedge.exe or chromium. Only needed if Friend cannot find one.</small>
      </label>
      <NumberField label="Longest a page may take (seconds)" value={timeoutSec} onChange={setTimeoutSec} min={5} max={60} />
      <NumberField label="Most page text given to the assistant (characters)" value={maxChars} onChange={setMaxChars} min={1000} max={30000} step={1000} />
      {note && !dirty && <p className="auth-note">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" disabled={!dirty || busy} onClick={() => setAsking(true)}>
          {dirty ? "Save…" : "Save"}
        </button>
      </div>
    </>
  );
}
