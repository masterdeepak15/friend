import { useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpSettingsApi, type SettingsApi } from "../settings/settingsApi";
import { NumberField } from "./NumberField";

interface Saved {
  keySet: boolean;
  depth: "basic" | "advanced";
  maxResults: number;
}

/**
 * The Configure page of the Tavily plugin: the owner's API key (write-only: it is never shown again, and an empty box leaves the saved one alone),
 * how deep a search reads and how many results it gives. Saved with the owner's PIN, like every other setting.
 */
export function TavilyForm({ api = httpSettingsApi }: { api?: SettingsApi }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  const [depth, setDepth] = useState<Saved["depth"]>("basic");
  const [maxResults, setMaxResults] = useState(5);
  const [key, setKey] = useState("");
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const adopt = (w: NonNullable<Awaited<ReturnType<SettingsApi["get"]>>["web"]>) => {
    const s: Saved = { keySet: w.tavilyKeySet, depth: w.tavily?.depth ?? "basic", maxResults: w.tavily?.maxResults ?? 5 };
    setSaved(s);
    setDepth(s.depth);
    setMaxResults(s.maxResults);
  };

  useEffect(() => {
    alive.current = true;
    api
      .get()
      .then((s) => alive.current && s.web && adopt(s.web))
      .catch((e: Error) => alive.current && setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [api]);

  const tavily: Record<string, unknown> = {};
  if (saved && depth !== saved.depth) tavily.depth = depth;
  if (saved && maxResults !== saved.maxResults) tavily.maxResults = maxResults;
  const web: Record<string, unknown> = {};
  if (key.trim()) web.tavilyKey = key.trim();
  if (Object.keys(tavily).length) web.tavily = tavily;
  const dirty = Object.keys(web).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.save({ web }, pin);
      if (!alive.current) return;
      if (r.settings.web) adopt(r.settings.web);
      setKey("");
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
      <label className="settings-field">
        <span>Tavily API key</span>
        <input type="password" autoComplete="off" aria-label="Tavily API key" placeholder={saved?.keySet ? "saved" : "tvly-…"} value={key} onChange={(e) => setKey(e.target.value)} />
        <small className="auth-note">{saved?.keySet ? "A key is saved. Type a new one only to replace it." : "From your Tavily account (tavily.com). It stays on this PC and is never shown to the assistant."}</small>
      </label>
      <label className="settings-field">
        <span>Search depth</span>
        <select value={depth} onChange={(e) => setDepth(e.target.value as Saved["depth"])}>
          <option value="basic">Basic (1 credit a search)</option>
          <option value="advanced">Advanced (2 credits, reads deeper)</option>
        </select>
      </label>
      <NumberField label="Results per search" value={maxResults} onChange={setMaxResults} min={1} max={8} />
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
