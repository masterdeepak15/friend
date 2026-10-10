import { useCallback, useEffect, useRef, useState } from "react";
import { touch } from "../overlay/touch";
import type { ChannelsView } from "./settingsApi";

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
const post = (pin: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) }) satisfies RequestInit;

export const httpChannelsApi: ChannelsApi = {
  status: () => call<ChannelStatus>("/api/channels"),
  link: (pin) => call<LinkInfo>("/api/channels/telegram/link", post(pin)),
  unlink: async (pin) => void (await call("/api/channels/telegram/unlink", post(pin))),
};

export interface ChannelSecrets {
  telegramToken: string;
  twilioToken: string;
}

type Tg = ChannelsView["telegram"];
type Tw = ChannelsView["twilio"];

/** The Telegram form: the bot token (write-only), and linking your own Telegram with a one-time code. */
export function TelegramForm({ view, secret, setSecret, api = httpChannelsApi }: { view: Tg; secret: string; setSecret: (s: string) => void; api?: ChannelsApi }) {
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [link, setLink] = useState<LinkInfo | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlinked, setUnlinked] = useState(false);
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

  const t = status?.telegram;
  const linked = !unlinked && view.linked && (t ? t.linked : true);

  const act = async (what: "link" | "unlink") => {
    if (pin.length < 6) return setError("Type your PIN first.");
    setBusy(true);
    setError(null);
    try {
      if (what === "link") setLink(await api.link(pin));
      else {
        await api.unlink(pin);
        setLink(null);
        setUnlinked(true);
      }
      setPin("");
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <p className="auth-note">
        Open Telegram, find <b>@BotFather</b>, send <code>/newbot</code>, and paste the token it gives you here.
      </p>
      <label className="settings-field">
        <span>Bot token</span>
        <input type="password" autoComplete="off" value={secret} placeholder={view.tokenSet ? "A token is saved. Type to replace it." : "123456789:ABC…"} onChange={(e) => setSecret(e.target.value)} style={touch} />
      </label>
      {t && view.enabled && (
        <p className={t.state === "error" ? "auth-error" : "auth-note"} role={t.state === "error" ? "alert" : "status"}>
          {{ off: "Off", connecting: "Connecting…", online: "Connected", error: "Not working" }[t.state]}
          {t.bot ? ` as @${t.bot}` : ""}
          {t.detail ? `: ${t.detail}` : ""}
        </p>
      )}
      {view.tokenSet && view.enabled && (
        <div className="channels-link">
          {linked ? <p className="auth-note">Your Telegram is linked. Messages from it are answered like on your PC, and anything risky is still decided here.</p> : <p className="auth-note">Not linked yet. Get a link code, then send it to your bot.</p>}
          <label className="settings-field">
            <span>PIN (to link or unlink)</span>
            <input type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} style={touch} />
          </label>
          <div className="approval-actions">
            {!linked && (
              <button type="button" style={touch} disabled={busy} onClick={() => void act("link")}>
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
      {!view.enabled && view.tokenSet && <p className="auth-note">Switch the plugin on (Turn on) to connect, then come back here to link your Telegram.</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The WhatsApp and SMS form (Twilio): account, numbers, and the address Twilio must call. */
export function TwilioForm({ view, setView, secret, setSecret, webhook }: { view: Tw; setView: (v: Tw) => void; secret: string; setSecret: (s: string) => void; webhook: string | null }) {
  const set = (patch: Partial<Tw>) => setView({ ...view, ...patch });
  return (
    <div className="settings-section">
      <p className="auth-note">
        Both use one Twilio account. Messages come in through an address Twilio calls, so Friend needs a public address (<code>friend config set publicUrl https://…</code>).
      </p>
      <label className="settings-field">
        <span>Account SID</span>
        <input value={view.accountSid} autoComplete="off" onChange={(e) => set({ accountSid: e.target.value })} placeholder="AC…" style={touch} />
      </label>
      <label className="settings-field">
        <span>Auth token</span>
        <input type="password" autoComplete="off" value={secret} placeholder={view.tokenSet ? "A token is saved. Type to replace it." : ""} onChange={(e) => setSecret(e.target.value)} style={touch} />
      </label>
      <label className="settings-field">
        <span>Your SMS number (the Twilio number)</span>
        <input value={view.smsFrom} inputMode="tel" onChange={(e) => set({ smsFrom: e.target.value })} placeholder="+14155550100" style={touch} />
      </label>
      <label className="settings-field">
        <span>Your WhatsApp number (the Twilio sender)</span>
        <input value={view.whatsappFrom} inputMode="tel" onChange={(e) => set({ whatsappFrom: e.target.value })} placeholder="+14155550101" style={touch} />
      </label>
      <label className="settings-field">
        <span>Your own phone number</span>
        <input value={view.ownerNumber} inputMode="tel" onChange={(e) => set({ ownerNumber: e.target.value })} placeholder="+919800000000" style={touch} />
      </label>
      <small className="auth-note">Only messages from this number are answered as you. Everyone else's go to the inbox as untrusted mail.</small>
      <p className="auth-note">
        {webhook ? (
          <>
            In Twilio, set the "when a message comes in" address (HTTP POST) to <code>{webhook}</code>
          </>
        ) : (
          "No public address is set yet, so Twilio cannot reach Friend."
        )}
      </p>
    </div>
  );
}
