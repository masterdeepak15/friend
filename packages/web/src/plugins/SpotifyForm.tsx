import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";

export interface SpotifyInfo {
  status: { connected: boolean; needs: string | null; account: string | null };
  /** The address to add to the Spotify app, built from Friend's public address. */
  redirectUri: string;
  /** The owner's saved client id (not secret). */
  clientId: string;
}

export interface SpotifyApi {
  info(): Promise<SpotifyInfo>;
  saveClientId(clientId: string, pin: string): Promise<void>;
  /** The Spotify page to send the browser to. */
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

export const httpSpotifyApi: SpotifyApi = {
  info: async () => {
    const r = await call<{ sources: { id: string; status: SpotifyInfo["status"] }[]; spotify: { redirectUri: string; clientId: string } }>("/api/music/sources");
    return { status: r.sources.find((s) => s.id === "spotify")?.status ?? { connected: false, needs: null, account: null }, redirectUri: r.spotify.redirectUri, clientId: r.spotify.clientId };
  },
  saveClientId: async (clientId, pin) => void (await post("/api/music/spotify/client-id", { clientId, pin })),
  connect: async (pin) => ((await post("/api/music/spotify/connect", { pin })) as { url: string }).url,
  disconnect: async (pin) => void (await post("/api/music/spotify/disconnect", { pin })),
};

/** The first thing wrong with a typed client id, or null. Empty is fine (nothing to save). */
export const spotifyClientIdProblem = (id: string): string | null => (id.trim() === "" || /^[A-Za-z0-9]{8,64}$/.test(id.trim()) ? null : "A client id is letters and digits only, copied from your app at developer.spotify.com.");

type Ask = "client" | "connect" | "disconnect";

/**
 * Connecting the owner's own Spotify account: the address to register in their Spotify app, their app's client id, and Connect.
 * Sign-in happens on Spotify's own page; nothing typed here is a password.
 */
export function SpotifyForm({ api = httpSpotifyApi, navigate = (url: string) => window.location.assign(url) }: { api?: SpotifyApi; navigate?: (url: string) => void }) {
  const [info, setInfo] = useState<SpotifyInfo | null>(null);
  const [clientId, setClientId] = useState("");
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
      if (asking === "client") {
        await api.saveClientId(clientId.trim(), pin);
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
        <p className="auth-note">Enter your PIN {asking === "client" ? "to save the client id" : asking === "connect" ? "to connect Spotify" : "to disconnect Spotify"}.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void run()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void run()}>
            {asking === "client" ? "Save" : "Continue"}
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

  const problem = spotifyClientIdProblem(clientId);
  const changed = !!info && clientId.trim() !== info.clientId;
  const saved = !!info?.clientId;
  const st = info?.status;
  return (
    <div className="settings-section">
      <label className="settings-field">
        <span>Redirect address to add in your Spotify app</span>
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
        <span>Client id of your Spotify app</span>
        <input type="text" value={clientId} maxLength={64} autoComplete="off" spellCheck={false} onChange={(e) => setClientId(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="auth-error">
          {problem}
        </p>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} disabled={!changed || !clientId.trim() || problem !== null} onClick={() => setAsking("client")}>
          Save client id
        </button>
        {st?.connected ? (
          <button type="button" style={touch} onClick={() => setAsking("disconnect")}>
            Disconnect Spotify
          </button>
        ) : (
          <button type="button" style={touch} className="primary" disabled={!saved || changed} onClick={() => setAsking("connect")}>
            Connect Spotify
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
      <small className="auth-note">Sign-in is on Spotify's own page: Friend never sees your Spotify password. A development-mode Spotify app allows up to five people, and playing needs Spotify Premium on the account.</small>
    </div>
  );
}
