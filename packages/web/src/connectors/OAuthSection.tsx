import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpOAuthApi, type OAuthApi, type OAuthService, type OAuthState } from "./oauthApi";

/** Opens an approval link on this screen, in a new tab that cannot reach back into Friend. */
const openLink = (link: string) => window.open(link, "_blank", "noopener,noreferrer");

const serviceText = (s: OAuthService): string => {
  if (!s.configured) return "Not set up";
  if (s.needsReconnect) return "Reconnect needed";
  if (s.connected) return s.account ? `Connected as ${s.account}` : "Connected";
  return "Ready to connect";
};

/**
 * Sign in to outside services with a link: no key to paste. Connect opens the service's own page (or sends the link to the phone);
 * what comes back is kept by Friend and never shown here.
 */
export function OAuthSection({ api = httpOAuthApi, onChanged }: { api?: OAuthApi; onChanged?: () => void }) {
  const [state, setState] = useState<OAuthState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ id: string; clientId: string; clientSecret: string; asking: boolean; pin: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await api.state();
      if (alive.current) setState(s);
    } catch {
      /* the section stays hidden when it cannot be read; connectors still work */
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
      onChanged?.();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const reached = (r: { link?: string; sent?: boolean; connected?: boolean }, toPhone: boolean) => {
    if (r.connected) return setNotice("It is already connected.");
    if (toPhone) {
      if (r.sent) return setNotice("The link was sent to your phone. It works once, for ten minutes.");
      setNotice("There is no phone app linked, so the link could not be sent. Use Connect on this screen.");
      return;
    }
    if (r.link) openLink(r.link);
    setNotice("Finish in the page that opened, then come back here.");
  };

  if (!state || (state.services.length === 0 && state.connectors.length === 0)) return error ? <p role="alert" className="auth-error">{error}</p> : null;

  return (
    <section aria-label="Sign in with a link">
      <h4 className="plugins-heading">Sign in with a link</h4>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {notice && <p className="auth-note">{notice}</p>}
      <ul className="plugin-list">
        {state.services.map((s) => (
          <li key={s.id}>
            <div className="plugin-info">
              <strong>{s.name}</strong> <small className="auth-note">{serviceText(s)}</small>
              {!s.configured && (
                <div className="auth-note">
                  The host has to register Friend with {s.name} once. Use this return address: <code>{s.redirectUri}</code>
                </div>
              )}
            </div>
            <div className="plugin-actions">
              {s.configured && (
                <>
                  <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => reached(await api.connectService(s.id, false), false))}>
                    {s.connected && !s.needsReconnect ? "Connect again" : "Connect"}
                  </button>
                  <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => reached(await api.connectService(s.id, true), true))}>
                    Send the link to my phone
                  </button>
                </>
              )}
              {s.connected && (
                <button type="button" style={touch} className="danger" disabled={busy} onClick={() => (confirm === s.id ? void run(async () => { setConfirm(null); await api.disconnectService(s.id); }) : setConfirm(s.id))}>
                  {confirm === s.id ? "Really disconnect?" : "Disconnect"}
                </button>
              )}
              <button type="button" style={touch} disabled={busy} onClick={() => setSetup({ id: s.id, clientId: "", clientSecret: "", asking: false, pin: "" })}>
                {s.configured ? "Change client ID" : "Add client ID"}
              </button>
            </div>
            {setup?.id === s.id && (
              <div className="settings-section">
                {!setup.asking ? (
                  <>
                    <label className="settings-field">
                      <span>Client ID</span>
                      <input value={setup.clientId} autoComplete="off" onChange={(e) => setSetup({ ...setup, clientId: e.target.value })} style={touch} />
                    </label>
                    <label className="settings-field">
                      <span>Client secret (only if the service gave one)</span>
                      <input type="password" value={setup.clientSecret} autoComplete="off" onChange={(e) => setSetup({ ...setup, clientSecret: e.target.value })} style={touch} />
                    </label>
                    <div className="approval-actions">
                      <button type="button" style={touch} className="primary" disabled={!setup.clientId.trim()} onClick={() => setSetup({ ...setup, asking: true })}>
                        Save…
                      </button>
                      <button type="button" style={touch} onClick={() => setSetup(null)}>
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="auth-note">Enter your PIN to save the client ID. A new one signs the old login out.</p>
                    <PinPad pin={setup.pin} onChange={(p) => setSetup({ ...setup, pin: p })} onSubmit={() => undefined} />
                    <div className="approval-actions">
                      <button
                        type="button"
                        style={touch}
                        className="primary"
                        disabled={busy || setup.pin.length < 6}
                        onClick={() =>
                          void run(async () => {
                            await api.setClient(s.id, setup.clientId.trim(), setup.clientSecret.trim() || undefined, setup.pin);
                            setSetup(null);
                          })
                        }
                      >
                        Save
                      </button>
                      <button type="button" style={touch} onClick={() => setSetup({ ...setup, asking: false, pin: "" })}>
                        Back
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
        {state.connectors.map((c) => (
          <li key={`c-${c.id}`}>
            <div className="plugin-info">
              <strong>{c.name}</strong> <small className="auth-note">{c.connected ? (c.account ? `Connected as ${c.account}` : "Connected") : c.status === "needs-approval" ? "Waiting for your approval" : c.status === "error" ? "Not working" : "Not connected"}</small>
            </div>
            <div className="plugin-actions">
              <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => reached(await api.connectConnector(c.id, false), false))}>
                Connect
              </button>
              <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => reached(await api.connectConnector(c.id, true), true))}>
                Send the link to my phone
              </button>
              {c.connected && (
                <button type="button" style={touch} className="danger" disabled={busy} onClick={() => (confirm === `c-${c.id}` ? void run(async () => { setConfirm(null); await api.disconnectConnector(c.id); }) : setConfirm(`c-${c.id}`))}>
                  {confirm === `c-${c.id}` ? "Really disconnect?" : "Disconnect"}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
