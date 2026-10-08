import { useEffect, useRef, useState, type ReactNode } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { diffSettings, httpSettingsApi, type ProviderName, type SettingsApi, type SettingsView } from "./settingsApi";

const PROVIDERS: { id: ProviderName; label: string; note: string }[] = [
  { id: "claude-code", label: "Claude subscription (Claude Code)", note: "Uses the Claude Code app you are signed in to. No API key." },
  { id: "claude", label: "Claude API key", note: "Pay per use with an Anthropic API key." },
  { id: "ollama", label: "Local model (Ollama)", note: "Runs on this PC. Free and private, but slower." },
];

const RESTART_LABEL: Record<string, string> = { "voice.enabled": "Speech on/off", "voice.ttsVoice": "Voice", "voice.sttModel": "Listening model" };

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      {children}
      {hint && <small className="auth-note">{hint}</small>}
    </label>
  );
}

/** Owner-opened panel: everything that can safely be changed from the screen. Saving needs the PIN, drawn by the client. */
export function SettingsPanel({ api = httpSettingsApi, onClose }: { api?: SettingsApi; onClose: () => void }) {
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .get()
      .then((s) => {
        if (!alive.current) return;
        setSaved(s);
        setDraft(structuredClone(s));
      })
      .catch((e: Error) => alive.current && setError(e.message));
    return () => {
      alive.current = false;
    };
  }, [api]);

  if (!draft || !saved) {
    return (
      <div className="approval settings glass" role="dialog" aria-label="Settings" style={{ pointerEvents: "auto" }}>
        <div className="approval-head">
          <span className="approval-title">Settings</span>
        </div>
        {error ? (
          <p role="alert" className="auth-error">
            {error}
          </p>
        ) : (
          <p className="auth-note">Loading…</p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const patch = diffSettings(saved, draft, apiKey);
  const dirty = Object.keys(patch).length > 0;
  const set = <G extends "ollama" | "claudeCode" | "voice">(group: G, field: keyof SettingsView[G], value: unknown) =>
    setDraft({ ...draft, [group]: { ...draft[group], [field]: value } });

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.save(patch, pin);
      if (!alive.current) return;
      setSaved(r.settings);
      setDraft(structuredClone(r.settings));
      setApiKey("");
      setAsking(false);
      setNote(r.restart.length ? `Saved. Restart Friend for: ${r.restart.map((k) => RESTART_LABEL[k] ?? k).join(", ")}.` : "Saved. It is in use now.");
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
      <div className="approval settings glass" role="dialog" aria-label="Settings" style={{ pointerEvents: "auto" }}>
        <div className="approval-head">
          <span className="approval-title">Settings</span>
        </div>
        <p className="auth-note">Enter your PIN to save these changes.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && void save()} />
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
      </div>
    );
  }

  const provider = PROVIDERS.find((p) => p.id === draft.provider)!;
  return (
    <div className="approval settings glass" role="dialog" aria-label="Settings" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Settings</span>
      </div>
      <div className="settings-body">
        <h4 className="plugins-heading">Screen</h4>
        <Field label="View" hint="Minimal: only the voice presence. Companion: plus a status line and a clock. Workspace: also the chat and the schedule. Drag any panel to move it.">
          <select value={draft.view} onChange={(e) => setDraft({ ...draft, view: e.target.value as SettingsView["view"] })}>
            <option value="minimal">Minimal</option>
            <option value="companion">Companion</option>
            <option value="workspace">Workspace</option>
          </select>
        </Field>

        <h4 className="plugins-heading">Where Friend thinks</h4>
        <Field label="Model provider" hint={provider.note}>
          <select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as ProviderName })}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {draft.provider === "claude-code" && (
          <>
            <Field label="Claude model" hint="sonnet, haiku, opus, or a full model name">
              <input list="cc-models" value={draft.claudeCode.model} onChange={(e) => set("claudeCode", "model", e.target.value)} />
              <datalist id="cc-models">
                <option value="sonnet" />
                <option value="haiku" />
                <option value="opus" />
              </datalist>
            </Field>
            <Field label="If Claude is unavailable" hint="For example when the plan's usage limit is reached.">
              <select value={draft.claudeCode.fallback} onChange={(e) => set("claudeCode", "fallback", e.target.value)}>
                <option value="ollama">Answer with the local model (Ollama)</option>
                <option value="none">Show an error</option>
              </select>
            </Field>
            <Field label="Claude Code command" hint="Leave as it is unless the program is somewhere else.">
              <input value={draft.claudeCode.command} onChange={(e) => set("claudeCode", "command", e.target.value)} />
            </Field>
          </>
        )}

        {draft.provider === "claude" && (
          <>
            <Field label="Claude model">
              <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
            </Field>
            <Field label="API key" hint={saved.apiKeySet ? "A key is saved. Type a new one only to replace it." : "No key saved yet."}>
              <input type="password" autoComplete="off" placeholder={saved.apiKeySet ? "saved" : "sk-ant-…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </Field>
          </>
        )}

        {(draft.provider === "ollama" || (draft.provider === "claude-code" && draft.claudeCode.fallback === "ollama")) && (
          <>
            <h4 className="plugins-heading">Local model (Ollama)</h4>
            <Field label="Address">
              <input value={draft.ollama.url} onChange={(e) => set("ollama", "url", e.target.value)} />
            </Field>
            <Field label="Model">
              <input value={draft.ollama.model} onChange={(e) => set("ollama", "model", e.target.value)} />
            </Field>
            <Field label="Memory window (tokens)">
              <input type="number" min={1024} max={131072} step={1024} value={draft.ollama.contextTokens} onChange={(e) => set("ollama", "contextTokens", Number(e.target.value))} />
            </Field>
            <label className="settings-check">
              <input type="checkbox" checked={draft.ollama.vision} onChange={(e) => set("ollama", "vision", e.target.checked)} /> This model can look at pictures
            </label>
          </>
        )}

        <h4 className="plugins-heading">Voice</h4>
        <label className="settings-check">
          <input type="checkbox" checked={draft.voice.speakTyped} onChange={(e) => set("voice", "speakTyped", e.target.checked)} /> Also speak the replies to typed messages
        </label>
        <Field label="Spoken language" hint="Empty detects it automatically. For example en or hi.">
          <input value={draft.voice.language ?? ""} maxLength={10} onChange={(e) => set("voice", "language", e.target.value.trim() === "" ? null : e.target.value.trim())} />
        </Field>
        <Field label={`"It is me" match level: ${draft.voice.accept.toFixed(2)}`} hint="Higher is stricter. Only matters after you enrolled your voice.">
          <input type="range" min={0.3} max={0.95} step={0.01} value={draft.voice.accept} onChange={(e) => set("voice", "accept", Number(e.target.value))} />
        </Field>
        <Field label={`"Ask for my PIN" level: ${draft.voice.challenge.toFixed(2)}`} hint="Voices between this and the level above must be confirmed with the PIN.">
          <input type="range" min={0.2} max={0.9} step={0.01} value={draft.voice.challenge} onChange={(e) => set("voice", "challenge", Number(e.target.value))} />
        </Field>
        <Field label="Speaking voice" hint="Needs a restart, and the voice must be set up first.">
          <input value={draft.voice.ttsVoice} onChange={(e) => set("voice", "ttsVoice", e.target.value)} />
        </Field>
        <Field label="Listening model" hint="tiny, base, small … Bigger is more accurate but slower. Needs a restart.">
          <input value={draft.voice.sttModel} onChange={(e) => set("voice", "sttModel", e.target.value)} />
        </Field>
      </div>

      {note && !dirty && <p className="auth-note">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" disabled={!dirty} onClick={() => { setNote(null); setError(null); setAsking(true); }}>
          Save…
        </button>
        <button type="button" style={touch} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="auth-note">Network, folders and safety rules are not here on purpose. Change those in the terminal: friend config set.</p>
    </div>
  );
}
