import { useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { TelegramForm, TwilioForm, httpChannelsApi, type ChannelStatus, type ChannelsApi } from "../settings/ChannelsTab";
import { httpSettingsApi, type ChannelsView, type SettingsApi } from "../settings/settingsApi";
import type { IntegrationEntry } from "./pluginsApi";

const EMPTY: ChannelsView = {
  telegram: { installed: false, enabled: false, tokenSet: false, linked: false },
  twilio: { installed: false, enabled: false, accountSid: "", tokenSet: false, smsFrom: "", whatsappFrom: "", ownerNumber: "" },
};

/**
 * The Configure page of one integration. What is typed here is saved with the owner's PIN, like every other setting; the
 * tokens are write-only. Turning the plugin on and off is done on the plugins list.
 */
export function IntegrationConfig({
  integration,
  onBack,
  settingsApi = httpSettingsApi,
  channelsApi = httpChannelsApi,
}: {
  integration: IntegrationEntry;
  onBack: () => void;
  settingsApi?: SettingsApi;
  channelsApi?: ChannelsApi;
}) {
  const [saved, setSaved] = useState<ChannelsView | null>(null);
  const [draft, setDraft] = useState<ChannelsView>(EMPTY);
  const [secret, setSecret] = useState("");
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);
  const isTelegram = integration.id === "telegram";

  useEffect(() => {
    alive.current = true;
    settingsApi
      .get()
      .then((s) => {
        if (!alive.current) return;
        const ch = s.channels ?? EMPTY;
        setSaved(ch);
        setDraft(structuredClone(ch));
      })
      .catch((e: Error) => alive.current && setError(e.message));
    channelsApi.status().then((s) => alive.current && setStatus(s)).catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [settingsApi, channelsApi]);

  // only what was changed goes to the server
  const patch = (): Record<string, unknown> => {
    if (!saved) return {};
    if (isTelegram) return secret.trim() ? { channels: { telegram: { botToken: secret.trim() } } } : {};
    const twilio: Record<string, unknown> = {};
    for (const k of ["accountSid", "smsFrom", "whatsappFrom", "ownerNumber"] as const) if (draft.twilio[k] !== saved.twilio[k]) twilio[k] = draft.twilio[k];
    if (secret.trim()) twilio.authToken = secret.trim();
    return Object.keys(twilio).length ? { channels: { twilio } } : {};
  };
  const changes = patch();
  const dirty = Object.keys(changes).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await settingsApi.save(changes, pin);
      if (!alive.current) return;
      const ch = r.settings.channels ?? EMPTY;
      setSaved(ch);
      setDraft(structuredClone(ch));
      setSecret("");
      setAsking(false);
      setNote(isTelegram && !integration.enabled ? "Saved. Now press Turn on in the plugins list." : "Saved.");
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
      </>
    );
  }

  return (
    <>
      <h4 className="plugins-heading">{integration.name}</h4>
      <p className="auth-note">{integration.detail || integration.description}</p>
      <ol className="integration-steps">
        {integration.steps.map((s, i) => (
          <li key={i} className={s.done ? "done" : undefined}>
            {s.text}
          </li>
        ))}
      </ol>
      {saved &&
        (isTelegram ? (
          <TelegramForm view={{ ...draft.telegram, enabled: integration.enabled }} secret={secret} setSecret={setSecret} api={channelsApi} />
        ) : (
          <TwilioForm view={draft.twilio} setView={(twilio) => setDraft({ ...draft, twilio })} secret={secret} setSecret={setSecret} webhook={status?.twilio.webhook ?? null} />
        ))}
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
        <button type="button" style={touch} onClick={onBack}>
          Back
        </button>
      </div>
    </>
  );
}
