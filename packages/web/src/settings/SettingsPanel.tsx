import { useEffect, useRef, useState, type ReactNode } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { LookPreview } from "./LookPreview";
import { HINDI_VOICES, MARATHI_VOICES, ORIGINAL_VOICE, VOICE_CHOICES, isCatalogVoice } from "@friend/protocol";
import { DEFAULT_LOOK, diffSettings, httpSettingsApi, needsPin, playVoicePreview, type Look, type ProviderName, type SettingsApi, type SettingsView } from "./settingsApi";
import { STYLES, SWATCHES, THEMES, isTheme } from "./themes";

export type SettingsTab = "model" | "voice" | "look";

const TABS: { id: SettingsTab; label: string; note: string }[] = [
  { id: "model", label: "Model", note: "Where Friend thinks" },
  { id: "voice", label: "Voice", note: "Speaking and listening" },
  { id: "look", label: "Voice presence", note: "How it looks" },
];

const PROVIDERS: { id: ProviderName; label: string; note: string }[] = [
  { id: "claude-code", label: "Claude subscription (Claude Code)", note: "Uses the Claude Code app you are signed in to. No API key." },
  { id: "claude", label: "Claude API key", note: "Pay per use with an Anthropic API key." },
  { id: "ollama", label: "Local model (Ollama)", note: "Runs on this PC. Free and private, but slower." },
  { id: "openai", label: "OpenAI-compatible server (OmniRoute, LM Studio…)", note: "Any server that speaks the OpenAI chat API. OmniRoute is one address that routes to many models, many of them free." },
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

/**
 * Owner-opened panel: everything that can safely be changed from the screen, in tabs. Anything that could change what runs
 * or where words are sent needs the PIN (drawn by the client); how the screen looks does not.
 */
export function SettingsPanel({ api = httpSettingsApi, onClose, initialTab = "model", preview = playVoicePreview }: { api?: SettingsApi; onClose: () => void; initialTab?: SettingsTab; preview?: (voice: string) => Promise<void> }) {
  const [saved, setSaved] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<SettingsView | null>(null);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [apiKey, setApiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [hearing, setHearing] = useState(false);
  const [hearNote, setHearNote] = useState<string | null>(null);
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
      .catch((e: Error) => alive.current && setError((e as Error).message));
    return () => {
      alive.current = false;
    };
  }, [api]);

  const shell = (children: ReactNode, wide = false) => (
    <div className={`approval settings glass${wide ? " settings-wide" : ""}`} role="dialog" aria-label="Settings" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Settings</span>
      </div>
      {children}
    </div>
  );

  if (!draft || !saved) {
    return shell(
      <>
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
      </>,
    );
  }

  const patch = diffSettings(saved, draft, apiKey, openaiKey);
  const dirty = Object.keys(patch).length > 0;
  const set = <G extends "ollama" | "claudeCode" | "voice" | "look">(group: G, field: keyof SettingsView[G], value: unknown) =>
    setDraft({ ...draft, [group]: { ...draft[group], [field]: value } });
  const look = draft.look;

  const save = async (withPin?: string) => {
    setError(null);
    setBusy(true);
    try {
      const r = await api.save(patch, withPin);
      if (!alive.current) return;
      setSaved(r.settings);
      setDraft(structuredClone(r.settings));
      setApiKey("");
      setOpenaiKey("");
      setAsking(false);
      const newVoice = patch.voice && (patch.voice as Record<string, unknown>).ttsVoice !== undefined;
      setNote(
        r.restart.length
          ? `Saved. Restart Friend for: ${r.restart.map((k) => RESTART_LABEL[k] ?? k).join(", ")}.`
          : newVoice
            ? "Saved. The new voice is loading; you will get a message when it is ready (the first time it downloads about 60 MB)."
            : needsPin(patch)
              ? "Saved. It is in use now."
              : "Saved. Every open screen has changed.",
      );
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
    return shell(
      <>
        <p className="auth-note">Enter your PIN to save these changes.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && void save(pin)} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void save(pin)}>
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
      </>,
    );
  }

  const provider = PROVIDERS.find((p) => p.id === draft.provider)!;

  const moveTab = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next]!.id);
    document.getElementById(`settings-tab-${TABS[next]!.id}`)?.focus();
  };

  const modelTab = (
    <>
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

      {draft.provider === "openai" && draft.openai && (
        <>
          <Field label="Server address" hint="Ends in /v1. OmniRoute: http://localhost:20128/v1 (install it with npm install -g omniroute, then run omniroute).">
            <input value={draft.openai.url} onChange={(e) => setDraft({ ...draft, openai: { ...draft.openai!, url: e.target.value } })} />
          </Field>
          <Field label="Model" hint="The name that server knows. OmniRoute answers to auto.">
            <input value={draft.openai.model} onChange={(e) => setDraft({ ...draft, openai: { ...draft.openai!, model: e.target.value } })} />
          </Field>
          <Field label="API key" hint={saved.openai?.apiKeySet ? "A key is saved. Type a new one only to replace it." : "Leave empty if the server asks for none."}>
            <input type="password" autoComplete="off" placeholder={saved.openai?.apiKeySet ? "saved" : ""} value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />
          </Field>
          <label className="settings-check">
            <input type="checkbox" checked={draft.openai.vision} onChange={(e) => setDraft({ ...draft, openai: { ...draft.openai!, vision: e.target.checked } })} /> This model can look at pictures
          </label>
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
    </>
  );

  const voiceTab = (
    <>
      <h4 className="plugins-heading">Speaking and listening</h4>
      <label className="settings-check">
        <input type="checkbox" checked={draft.voice.speakTyped} onChange={(e) => set("voice", "speakTyped", e.target.checked)} /> Also speak the replies to typed messages
      </label>
      <Field label="Spoken language" hint="Leave empty to detect it by itself: best when you mix English, Hindi and Marathi. Or force one: en, hi, mr.">
        <input value={draft.voice.language ?? ""} maxLength={10} onChange={(e) => set("voice", "language", e.target.value.trim() === "" ? null : e.target.value.trim())} />
      </Field>
      <Field label="Speaking voice" hint="Female or male. The first time a voice is used it downloads about 60 MB, then it works without internet.">
        <select value={draft.voice.ttsVoice} onChange={(e) => set("voice", "ttsVoice", e.target.value)}>
          <optgroup label="Female">
            {VOICE_CHOICES.filter((v) => v.gender === "female").map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.accent}
                {v.note ? ` · ${v.note}` : ""}
              </option>
            ))}
          </optgroup>
          <optgroup label="Male">
            {VOICE_CHOICES.filter((v) => v.gender === "male").map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} · {v.accent}
                {v.note ? ` · ${v.note}` : ""}
              </option>
            ))}
          </optgroup>
          <optgroup label="Original">
            <option value={ORIGINAL_VOICE.id}>
              {ORIGINAL_VOICE.name} · {ORIGINAL_VOICE.accent} · {ORIGINAL_VOICE.note}
            </option>
          </optgroup>
          {!isCatalogVoice(draft.voice.ttsVoice) && (
            <optgroup label="Other">
              <option value={draft.voice.ttsVoice}>{draft.voice.ttsVoice}</option>
            </optgroup>
          )}
        </select>
      </Field>
      <Field label="Hindi voice" hint="Reads Hindi (Devanagari) text; English words in the same sentence still use the voice above. The first time it downloads about 64 MB.">
        <select value={draft.voice.hindiVoice ?? ""} onChange={(e) => set("voice", "hindiVoice", e.target.value)}>
          <option value="">Same as the voice above</option>
          {HINDI_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {v.gender}
              {v.note ? ` · ${v.note}` : ""}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Marathi voice" hint="Reads Marathi text. Friend tells Marathi from Hindi by the words used.">
        <select value={draft.voice.marathiVoice ?? ""} onChange={(e) => set("voice", "marathiVoice", e.target.value)}>
          <option value="">Same as the voice above</option>
          {MARATHI_VOICES.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </Field>
      <div className="voice-hear">
        <button
          type="button"
          style={touch}
          disabled={hearing}
          onClick={() => {
            setHearing(true);
            setHearNote(null);
            preview(draft.voice.ttsVoice)
              .then(() => alive.current && setHearNote("Playing…"))
              .catch((e: Error) => alive.current && setHearNote(e.message))
              .finally(() => alive.current && setHearing(false));
          }}
        >
          {hearing ? "Loading the voice…" : "Hear it"}
        </button>
        {hearNote && (
          <small className="auth-note" role="status">
            {hearNote}
          </small>
        )}
      </div>
      <Field label="Listening model" hint="tiny, base, small … Bigger is more accurate but slower. For Hindi and Marathi use small or larger (base mishears them). Needs a restart.">
        <input value={draft.voice.sttModel} onChange={(e) => set("voice", "sttModel", e.target.value)} />
      </Field>
      <h4 className="plugins-heading">Who is speaking</h4>
      <Field label={`"It is me" match level: ${draft.voice.accept.toFixed(2)}`} hint="Higher is stricter. Only matters after you enrolled your voice.">
        <input type="range" min={0.3} max={0.95} step={0.01} value={draft.voice.accept} onChange={(e) => set("voice", "accept", Number(e.target.value))} />
      </Field>
      <Field label={`"Ask for my PIN" level: ${draft.voice.challenge.toFixed(2)}`} hint="Voices between this and the level above must be confirmed with the PIN.">
        <input type="range" min={0.2} max={0.9} step={0.01} value={draft.voice.challenge} onChange={(e) => set("voice", "challenge", Number(e.target.value))} />
      </Field>
    </>
  );

  const lookTab = (
    <div className="look-tab">
      <div className="look-side">
        <LookPreview look={look} />
        <p className="auth-note">This is a live preview. Nothing changes on the screen until you save.</p>
        <button type="button" style={touch} onClick={() => setDraft({ ...draft, look: { ...DEFAULT_LOOK } })}>
          Back to the default look
        </button>
      </div>
      <div className="look-controls">
        <h4 className="plugins-heading">Themes</h4>
        <div className="theme-grid" role="group" aria-label="Themes">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`theme-card${isTheme(look, t) ? " on" : ""}`}
              aria-pressed={isTheme(look, t)}
              style={{ ["--swatch" as string]: t.accent }}
              onClick={() => setDraft({ ...draft, look: { ...look, style: t.style, accent: t.accent, intensity: t.intensity } })}
            >
              <i aria-hidden="true" />
              <b>{t.name}</b>
              <small>{t.style}</small>
            </button>
          ))}
        </div>

        <h4 className="plugins-heading">Shape</h4>
        <div className="style-row" role="radiogroup" aria-label="Style">
          {STYLES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={look.style === s.id} className={`style-choice${look.style === s.id ? " on" : ""}`} onClick={() => set("look", "style", s.id)}>
              <b>{s.name}</b>
              <small>{s.note}</small>
            </button>
          ))}
        </div>

        <h4 className="plugins-heading">Colour and light</h4>
        <div className="swatch-row" role="group" aria-label="Colour">
          {SWATCHES.map((c) => (
            <button key={c} type="button" aria-label={`Colour ${c}`} aria-pressed={look.accent.toLowerCase() === c} className={`swatch${look.accent.toLowerCase() === c ? " on" : ""}`} style={{ background: c }} onClick={() => set("look", "accent", c)} />
          ))}
          <label className="swatch-custom">
            <span>Other</span>
            <input type="color" aria-label="Pick another colour" value={look.accent} onChange={(e) => set("look", "accent", e.target.value.toLowerCase())} />
          </label>
        </div>
        <Field label={`Brightness: ${Math.round(look.intensity * 100)}%`}>
          <input type="range" min={0} max={1} step={0.05} value={look.intensity} onChange={(e) => set("look", "intensity", Number(e.target.value))} />
        </Field>
        <Field label={`Size: ${Math.round(look.size * 100)}%`} hint="How big it is in the middle of the screen.">
          <input type="range" min={0.5} max={1.5} step={0.05} value={look.size} onChange={(e) => set("look", "size", Number(e.target.value))} />
        </Field>
        <Field label={`Reaction to my voice: ${Math.round(look.reactivity * 100)}%`} hint="Low is calm, high moves a lot when anyone speaks.">
          <input type="range" min={0} max={1} step={0.05} value={look.reactivity} onChange={(e) => set("look", "reactivity", Number(e.target.value))} />
        </Field>
        <label className="settings-check">
          <input type="checkbox" checked={look.ambient} onChange={(e) => set("look", "ambient", e.target.checked)} /> Soft glow behind everything
        </label>

        <h4 className="plugins-heading">Words on the screen</h4>
        <label className="settings-check">
          <input type="checkbox" checked={look.captions} onChange={(e) => set("look", "captions", e.target.checked)} /> Show the live words while Friend speaks
        </label>
        <Field label="Caption size">
          <select value={look.captionSize} disabled={!look.captions} onChange={(e) => set("look", "captionSize", e.target.value as Look["captionSize"])}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </Field>

        <h4 className="plugins-heading">What is on the screen</h4>
        <Field label="Your name" hint="Shown on the badge in the corner, next to the shield, while you are signed in. Empty shows Owner.">
          <input value={draft.ownerName ?? ""} maxLength={40} placeholder="Owner" onChange={(e) => setDraft({ ...draft, ownerName: e.target.value })} />
        </Field>
        <Field label="View" hint="Minimal: only the voice presence. Companion: plus a status line and a clock. Workspace: also the chat and the schedule. Drag any panel to move it.">
          <select value={draft.view} onChange={(e) => setDraft({ ...draft, view: e.target.value as SettingsView["view"] })}>
            <option value="minimal">Minimal</option>
            <option value="companion">Companion</option>
            <option value="workspace">Workspace</option>
          </select>
        </Field>
        <label className="settings-check">
          <input type="checkbox" checked={look.aiMayChange} onChange={(e) => set("look", "aiMayChange", e.target.checked)} /> Let the AI change the shape, colour and brightness to suit a topic
        </label>
        <small className="auth-note">Off keeps exactly the look you chose. You can still ask it to change the look yourself.</small>
      </div>
    </div>
  );

  return shell(
    <>
      <div className="settings-layout">
        <div className="settings-tabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={moveTab}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`settings-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`settings-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`settings-tab${tab === t.id ? " on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <b>{t.label}</b>
              <small>{t.note}</small>
            </button>
          ))}
        </div>
        <div className="settings-body" role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === "model" && modelTab}
          {tab === "voice" && voiceTab}
          {tab === "look" && lookTab}
        </div>
      </div>

      {note && !dirty && <p className="auth-note">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <div className="approval-actions">
        <button
          type="button"
          style={touch}
          className="primary"
          disabled={!dirty || busy}
          onClick={() => {
            setNote(null);
            setError(null);
            if (needsPin(patch)) setAsking(true);
            else void save();
          }}
        >
          {dirty && !needsPin(patch) ? "Save" : "Save…"}
        </button>
        {dirty && (
          <button
            type="button"
            style={touch}
            onClick={() => {
              setDraft(structuredClone(saved));
              setApiKey("");
              setOpenaiKey("");
            }}
          >
            Undo changes
          </button>
        )}
        <button type="button" style={touch} onClick={onClose}>
          Close
        </button>
      </div>
      <p className="auth-note">Network, folders and safety rules are not here on purpose. Change those in the terminal: friend config set.</p>
    </>,
    true,
  );
}
