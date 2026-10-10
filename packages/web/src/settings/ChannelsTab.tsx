import { useCallback, useEffect, useRef, useState } from "react";
import { touch } from "../overlay/touch";
import type { ChannelsView, SettingsView } from "./settingsApi";

export interface ChannelStatus {
  telegram: { enabled: boolean; tokenSet: boolean; linked: boolean; state: "off" | "connecting" | "online" | "error"; detail: string; bot: string | null };
  twilio: { enabled: boolean; tokenSet: boolean; ownerSet: boolean; sms: boolean; whatsapp: boolean; webhook: string | null };
  unread: number;
}
export interface LinkInfo {
  code: string;
  bot: string | null;
  expiresInSeconds: number;
}
export interface ChannelsApi {
  status(): Promise<ChannelStatus>;
  link(pin: string): Promise<LinkInfo>;
  unlink(pin: string): Promise<void>;
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
const post = (path: string, pin: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) }) satisfies RequestInit;

export const httpChannelsApi: ChannelsApi = {
  status: () => call<ChannelStatus>("/api/channels"),
  link: (pin) => call<LinkInfo>("/api/channels/telegram/link", post("", pin)),
  unlink: async (pin) => void (await call("/api/channels/telegram/unlink", post("", pin))),
};

const STATE_TEXT: Record<ChannelStatus["telegram"]["state"], string> = { off: "Off", connecting: "Connecting…", online: "Connected", error: "Not working" };

export interface ChannelSecrets {
  telegramToken: string;
  twilioToken: string;
}

/** Telegram, SMS and WhatsApp. The tokens are typed here and never shown again; saving needs the PIN like every other setting. */
export function ChannelsTab({
  draft,
  setDraft,
  secrets,
  setSecrets,
  api = httpChannelsApi,
}: {
  draft: SettingsView;
  setDraft: (v: SettingsView) => void;
  secrets: ChannelSecrets;
  setSecrets: (s: ChannelSecrets) => void;
  api?: ChannelsApi;
}) {
  const ch: ChannelsView = draft.channels ?? DEFAULT_VIEW;
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(() => {
    api.status().then((s) => alive.current && setStatus(s)).catch(() => {});
  }, [api]);
  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, 4000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  const set = (patch: Partial<ChannelsView>) => setDraft({ ...draft, channels: { ...ch, ...patch } });
  const tg = (patch: Partial<ChannelsView["telegram"]>) => set({ telegram: { ...ch.telegram, ...patch } });
  const tw = (patch: Partial<ChannelsView["twilio"]>) => set({ twilio: { ...ch.twilio, ...patch } });

  const act = async (what: "link" | "unlink") => {
    if (pin.length < 6) return setError("Type your PIN first.");
    setBusy(true);
    setError(null);
    try {
      if (what === "link") setLink(await api.link(pin));
      else {
        await api.unlink(pin);
        setLink(null);
        tg({ linked: false });
      }
      setPin("");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const t = status?.telegram;
  const linked = ch.telegram.linked && (t ? t.linked : true);
  return (
    <div className="settings-section">
      <h3>Telegram</h3>
      <p className="auth-note">Talk to Friend from your phone, and let it message people for you. Open Telegram, find <b>@BotFather</b>, send <code>/newbot</code>, and paste the token it gives you here.</p>
      <label className="settings-check">
        <input type="checkbox" checked={ch.telegram.enabled} onChange={(e) => tg({ enabled: e.target.checked })} /> Switch Telegram on
      </label>
      <label className="settings-field">
        <span>Bot token</span>
        <input type="password" autoComplete="off" value={secrets.telegramToken} placeholder={ch.telegram.tokenSet ? "A token is saved. Type to replace it." : "123456789:ABC…"} onChange={(e) => setSecrets({ ...secrets, telegramToken: e.target.value })} style={touch} />
      </label>
      {t && ch.telegram.enabled && (
        <p className={t.state === "error" ? "auth-error" : "auth-note"} role={t.state === "error" ? "alert" : "status"}>
          {STATE_TEXT[t.state]}
          {t.bot ? ` as @${t.bot}` : ""}
          {t.detail ? `: ${t.detail}` : ""}
        </p>
      )}
      {ch.telegram.enabled && ch.telegram.tokenSet && (
        <div className="channels-link">
          {linked ? <p className="auth-note">Your Telegram is linked. Messages from it are answered like on your PC, and anything risky is still decided here.</p> : <p className="auth-note">Not linked yet. Save first, then get a link code.</p>}
          <label className="settings-field">
            <span>PIN (to link or unlink)</span>
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={touch} />
          </label>
          <div className="approval-actions">
            {!linked && (
              <button type="button" style={touch} disabled={busy || !ch.telegram.tokenSet} onClick={() => void act("link")}>
                Get a link code
              </button>
            )}
            {linked && (
              <button type="button" style={touch} disabled={busy} onClick={() => void act("unlink")}>
                Unlink
              </button>
            )}
          </div>
          {link && !linked && (
            <p className="auth-note" role="status">
              In Telegram, open {link.bot ? `@${link.bot}` : "your bot"} and send: <code>/link {link.code}</code> (works for {Math.round(link.expiresInSeconds / 60)} minutes).
            </p>
          )}
        </div>
      )}

      <h3>SMS and WhatsApp (Twilio)</h3>
      <p className="auth-note">Both use one Twilio account. Messages come in through an address Twilio calls, so Friend needs a public address (<code>friend config set publicUrl https://…</code>).</p>
      <label className="settings-check">
        <input type="checkbox" checked={ch.twilio.enabled} onChange={(e) => tw({ enabled: e.target.checked })} /> Switch SMS and WhatsApp on
      </label>
      <label className="settings-field">
        <span>Account SID</span>
        <input value={ch.twilio.accountSid} autoComplete="off" onChange={(e) => tw({ accountSid: e.target.value })} placeholder="AC…" style={touch} />
      </label>
      <label className="settings-field">
        <span>Auth token</span>
        <input type="password" autoComplete="off" value={secrets.twilioToken} placeholder={ch.twilio.tokenSet ? "A token is saved. Type to replace it." : ""} onChange={(e) => setSecrets({ ...secrets, twilioToken: e.target.value })} style={touch} />
      </label>
      <label className="settings-field">
        <span>Your SMS number (the Twilio number)</span>
        <input value={ch.twilio.smsFrom} inputMode="tel" onChange={(e) => tw({ smsFrom: e.target.value })} placeholder="+14155550100" style={touch} />
      </label>
      <label className="settings-field">
        <span>Your WhatsApp number (the Twilio sender)</span>
        <input value={ch.twilio.whatsappFrom} inputMode="tel" onChange={(e) => tw({ whatsappFrom: e.target.value })} placeholder="+14155550101" style={touch} />
      </label>
      <label className="settings-field">
        <span>Your own phone number</span>
        <input value={ch.twilio.ownerNumber} inputMode="tel" onChange={(e) => tw({ ownerNumber: e.target.value })} placeholder="+919800000000" style={touch} />
      </label>
      <small className="auth-note">Only messages from this number are answered as you. Everyone else's go to the inbox as untrusted mail.</small>
      {status && ch.twilio.enabled && (
        <p className="auth-note">
          {status.twilio.webhook ? (
            <>
              In Twilio, set the "when a message comes in" address (HTTP POST) to <code>{status.twilio.webhook}</code>
            </>
          ) : (
            "No public address is set yet, so Twilio cannot reach Friend."
          )}
        </p>
      )}
      {status && status.unread > 0 && <p className="auth-note">{status.unread} unread message{status.unread === 1 ? "" : "s"} from other people. Ask Friend: "did anyone reply?"</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <p className="auth-note">Changes here are saved with the Save button below, and need your PIN. Whether Friend asks before it sends a message follows Settings, Approvals.</p>
    </div>
  );
}

const DEFAULT_VIEW: ChannelsView = {
  telegram: { enabled: false, tokenSet: false, linked: false },
  twilio: { enabled: false, accountSid: "", tokenSet: false, smsFrom: "", whatsappFrom: "", ownerNumber: "" },
};
