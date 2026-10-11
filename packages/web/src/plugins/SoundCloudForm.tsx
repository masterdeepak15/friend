import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";

export interface SoundCloudInfo {
  status: { connected: boolean; needs: string | null; account: string | null };
  /** The address to add to the SoundCloud app, built from Friend's public address. */
  redirectUri: string;
  /** The owner's saved client id (not secret). */
  clientId: string;
  /** Whether a client secret is saved. The secret itself is never sent back. */
  secretSet: boolean;
}

export interface SoundCloudApi {
  info(): Promise<SoundCloudInfo>;
  /** The secret is left out when only the client id changes. */
  saveCredentials(clientId: string, clientSecret: string | undefined, pin: string): Promise<void>;
  /** The SoundCloud page to send the browser to. */
  connect(pin: string): Promise<string>;
  disconnect(pin: string): Promise<void>;
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
const post = (path: string, body: unknown): Promise<unknown> => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const httpSoundCloudApi: SoundCloudApi = {
  info: async () => {
    const r = await call<{ sources: { id: string; status: SoundCloudInfo["status"] }[]; soundcloud: { redirectUri: string; clientId: string; secretSet: boolean } }>("/api/music/sources");
    return { status: r.sources.find((s) => s.id === "soundcloud")?.status ?? { connected: false, needs: null, account: null }, redirectUri: r.soundcloud.redirectUri, clientId: r.soundcloud.clientId, secretSet: r.soundcloud.secretSet };
  },
  saveCredentials: async (clientId, clientSecret, pin) => void (await post("/api/music/soundcloud/credentials", { clientId, ...(clientSecret ? { clientSecret } : {}), pin })),
  connect: async (pin) => ((await post("/api/music/soundcloud/connect", { pin })) as { url: string }).url,
  disconnect: async (pin) => void (await post("/api/music/soundcloud/disconnect", { pin })),
};

/** The first thing wrong with a typed client id, or null. Empty is fine (nothing to save). */
export const soundcloudClientIdProblem = (id: string): string | null => (id.trim() === "" || /^[A-Za-z0-9]{8,64}$/.test(id.trim()) ? null : "A client id is letters and digits only, copied from your app at soundcloud.com/you/apps.");

type Ask = "save" | "connect" | "disconnect";

/**
 * Connecting the owner's own SoundCloud account: the address to register in their SoundCloud app, the app's client id and secret
 * (the secret is write-only), and Connect. Sign-in happens on SoundCloud's own page; nothing typed here is a password.
 */
export function SoundCloudForm({ api = httpSoundCloudApi, navigate = (url: string) => window.location.assign(url) }: { api?: SoundCloudApi; navigate?: (url: string) => void }) {
  const [info, setInfo] = useState<SoundCloudInfo | null>(null);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [asking, setAsking] = useState<Ask | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const i = await api.info();
      if (!alive.current) return;
      setInfo(i);
      setClientId(i.clientId);
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

  const run = async () => {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      if (asking === "save") {
        await api.saveCredentials(clientId.trim(), secret.trim() || undefined, pin);
        if (alive.current) setSecret("");
        await refresh();
      } else if (asking === "connect") {
        navigate(await api.connect(pin));
      } else {
        await api.disconnect(pin);
        await refresh();
      }
      if (alive.current) setAsking(null);
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
        <p className="auth-note">Enter your PIN {asking === "save" ? "to save the SoundCloud app details" : asking === "connect" ? "to connect SoundCloud" : "to disconnect SoundCloud"}.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void run()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void run()}>
            {asking === "save" ? "Save" : "Continue"}
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

  const problem = soundcloudClientIdProblem(clientId);
  const idChanged = !!info && clientId.trim() !== info.clientId;
  const changed = idChanged || secret.trim() !== "";
  const ready = !!info?.clientId && info.secretSet;
  const st = info?.status;
  return (
    <div className="settings-section">
      <label className="settings-field">
        <span>Redirect address to add in your SoundCloud app</span>
        <div style={{ display: "flex", gap: 6 }}>
          <input type="text" readOnly value={info?.redirectUri ?? ""} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(info?.redirectUri ?? "").then(() => setCopied(true), () => {});
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </label>
      <label className="settings-field">
        <span>Client id of your SoundCloud app</span>
        <input type="text" value={clientId} maxLength={64} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
      </label>
      <label className="settings-field">
        <span>Client secret of your SoundCloud app</span>
        <input type="password" value={secret} maxLength={200} autoComplete="new-password" spellCheck={false} onChange={(e) => setSecret(e.target.value)} />
        {info?.secretSet && <small className="auth-note">The secret is saved. Type a new one only to replace it.</small>}
      </label>
      {problem && (
        <p role="alert" className="auth-error">
          {problem}
        </p>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} disabled={!changed || !clientId.trim() || problem !== null || (!info?.secretSet && !secret.trim())} onClick={() => setAsking("save")}>
          Save
        </button>
        {st?.connected ? (
          <button type="button" style={touch} onClick={() => setAsking("disconnect")}>
            Disconnect SoundCloud
          </button>
        ) : (
          <button type="button" style={touch} className="primary" disabled={!ready || changed} onClick={() => setAsking("connect")}>
            Connect SoundCloud
          </button>
        )}
      </div>
      {st?.connected && <p className="auth-note">Connected as {st.account ?? "your account"}.</p>}
      {st?.needs && <p className="auth-note">{st.needs}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <small className="auth-note">Sign-in is on SoundCloud's own page: Friend never sees your SoundCloud password. SoundCloud decides who can register an app, and some tracks only play with the right SoundCloud plan.</small>
    </div>
  );
}
