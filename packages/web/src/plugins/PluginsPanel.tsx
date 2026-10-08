import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpPluginsApi, type CatalogPlugin, type PluginList, type PluginsApi } from "./pluginsApi";

type Pending = { kind: "install"; plugin: CatalogPlugin } | { kind: "enable"; id: string; name: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Owner-opened panel: see, add, switch and remove plugins. Adding or switching on needs the PIN; it is drawn by the client. */
export function PluginsPanel({ api = httpPluginsApi, onClose }: { api?: PluginsApi; onClose: () => void }) {
  const [list, setList] = useState<PluginList | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const l = await api.list();
      if (alive.current) setList(l);
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

  const run = async (job: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await job();
      if (!alive.current) return;
      setPending(null);
      await refresh();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setPin("");
      }
    }
  };

  const confirm = () => {
    if (!pending) return;
    void run(() => (pending.kind === "install" ? api.install(pending.plugin.id, pin) : api.setEnabled(pending.id, true, pin)));
  };

  const offers = (list?.catalog ?? []).filter((c) => !c.installed);

  return (
    <div className="approval plugins glass" role="dialog" aria-label="Plugins" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Plugins</span>
      </div>

      {pending ? (
        <>
          <p className="auth-note">
            {pending.kind === "install"
              ? `Install ${pending.plugin.name}? ${pending.plugin.tools > 0 ? "Its tools run in a Docker sandbox with no network and no access to your files, and ask for your approval every time. " : ""}Enter your PIN to confirm.`
              : `Switch on ${pending.name}? Enter your PIN to confirm.`}
          </p>
          <PinPad pin={pin} onChange={setPin} />
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <div className="approval-actions">
            <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={confirm}>
              Confirm
            </button>
            <button
              type="button"
              style={touch}
              onClick={() => {
                setPending(null);
                setPin("");
                setError(null);
              }}
            >
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <h4 className="plugins-heading">Installed</h4>
          {list && list.installed.length === 0 && <p className="auth-note">Nothing installed yet.</p>}
          <ul className="plugin-list">
            {(list?.installed ?? []).map((p) => (
              <li key={p.id}>
                <div className="plugin-info">
                  <strong>{p.name}</strong> <small>{p.version}</small>
                  <div className="auth-note">
                    {p.error ? `This plugin cannot be used: ${p.error}` : `${plural(p.skills.length, "skill")}, ${plural(p.tools.length, "tool")}${p.enabled ? "" : " (off)"}`}
                  </div>
                </div>
                <div className="plugin-actions">
                  <button
                    type="button"
                    style={touch}
                    disabled={busy}
                    onClick={() => (p.enabled ? void run(() => api.setEnabled(p.id, false, undefined)) : setPending({ kind: "enable", id: p.id, name: p.name }))}
                  >
                    {p.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button type="button" style={touch} className="danger" disabled={busy} onClick={() => void run(() => api.remove(p.id))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <h4 className="plugins-heading">Available</h4>
          {list && offers.length === 0 && <p className="auth-note">Everything in the catalog is installed.</p>}
          <ul className="plugin-list">
            {offers.map((c) => (
              <li key={c.id}>
                <div className="plugin-info">
                  <strong>{c.name}</strong> <small>{c.version}</small>
                  <div className="auth-note">{c.error ? `Cannot be installed: ${c.error}` : `${c.description} (${plural(c.skills, "skill")}, ${plural(c.tools, "tool")})`}</div>
                </div>
                <div className="plugin-actions">
                  <button type="button" style={touch} className="primary" disabled={busy || !!c.error} onClick={() => setPending({ kind: "install", plugin: c })}>
                    Install
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="approval-actions">
            <button type="button" style={touch} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
