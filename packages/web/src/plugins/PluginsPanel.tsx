import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { IntegrationConfig } from "./IntegrationConfig";
import { httpPluginsApi, type CatalogPlugin, type IntegrationEntry, type PluginList, type PluginsApi } from "./pluginsApi";

type Pending = { kind: "install"; plugin: CatalogPlugin; integration?: boolean } | { kind: "enable"; id: string; name: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const STATE_WORD: Record<IntegrationEntry["state"], string> = {
  "not-installed": "",
  "needs-setup": "Needs setup",
  off: "Off",
  connecting: "Connecting…",
  online: "On",
  error: "Not working",
};

/** What the install card offers for an integration: it looks like any other catalog plugin. */
const asOffer = (i: IntegrationEntry): CatalogPlugin => ({ id: i.id, name: i.name, version: "", description: i.description, tools: 0, skills: 0, error: null, installed: false });

/**
 * Owner-opened panel: see, add, set up, switch and remove plugins. That includes the built-in integrations (Telegram,
 * WhatsApp and SMS), which get a Configure page once they are installed. Adding or switching on needs the PIN.
 */
export function PluginsPanel({ api = httpPluginsApi, onClose, initialConfigure }: { api?: PluginsApi; onClose: () => void; initialConfigure?: string }) {
  const [list, setList] = useState<PluginList | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(initialConfigure ?? null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  // the assistant can open the screen at one integration's Configure page
  useEffect(() => {
    if (initialConfigure) setConfiguring(initialConfigure);
  }, [initialConfigure]);

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

  const integrations = list?.integrations ?? [];
  const offers = (list?.catalog ?? []).filter((c) => !c.installed);
  const installedIntegrations = integrations.filter((i) => i.installed);
  const offeredIntegrations = integrations.filter((i) => !i.installed);
  const shown = configuring ? integrations.find((i) => i.id === configuring && i.installed) : undefined;

  return (
    <div className="approval plugins glass" role="dialog" aria-label="Plugins" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Plugins</span>
      </div>

      {pending ? (
        <>
          <p className="auth-note">
            {pending.kind === "install"
              ? pending.integration
                ? `Install ${pending.plugin.name}? It connects Friend to an outside service, and you set it up afterwards. Enter your PIN to confirm.`
                : `Install ${pending.plugin.name}? ${pending.plugin.tools > 0 ? "Its tools run in a Docker sandbox with no network and no access to your files, and ask for your approval every time. " : ""}Enter your PIN to confirm.`
              : `Switch on ${pending.name}? Enter your PIN to confirm.`}
          </p>
          <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && confirm()} />
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
      ) : shown ? (
        <IntegrationConfig
          integration={shown}
          onBack={() => {
            setConfiguring(null);
            void refresh();
          }}
        />
      ) : (
        <>
          {error && (
            <p role="alert" className="auth-error">
              {error}
            </p>
          )}
          <h4 className="plugins-heading">Installed</h4>
          {list && list.installed.length === 0 && installedIntegrations.length === 0 && <p className="auth-note">Nothing installed yet.</p>}
          <ul className="plugin-list">
            {installedIntegrations.map((i) => (
              <li key={i.id} data-integration={i.id}>
                <div className="plugin-info">
                  <strong>{i.name}</strong> <small>{STATE_WORD[i.state]}</small>
                  <div className={i.state === "error" ? "auth-error" : "auth-note"}>{i.detail}</div>
                </div>
                <div className="plugin-actions">
                  <button type="button" style={touch} className="primary" disabled={busy} onClick={() => setConfiguring(i.id)}>
                    Configure
                  </button>
                  <button
                    type="button"
                    style={touch}
                    disabled={busy}
                    onClick={() => (i.enabled ? void run(() => api.setEnabled(i.id, false, undefined)) : setPending({ kind: "enable", id: i.id, name: i.name }))}
                  >
                    {i.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button type="button" style={touch} className="danger" disabled={busy} onClick={() => void run(() => api.remove(i.id))}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
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
          {list && offers.length === 0 && offeredIntegrations.length === 0 && <p className="auth-note">Everything in the catalog is installed.</p>}
          <ul className="plugin-list">
            {offeredIntegrations.map((i) => (
              <li key={i.id} data-integration={i.id}>
                <div className="plugin-info">
                  <strong>{i.name}</strong> <small>integration</small>
                  <div className="auth-note">{i.description}</div>
                </div>
                <div className="plugin-actions">
                  <button type="button" style={touch} className="primary" disabled={busy} onClick={() => setPending({ kind: "install", plugin: asOffer(i), integration: true })}>
                    Install
                  </button>
                </div>
              </li>
            ))}
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
            <button type="button" style={touch} disabled={busy} onClick={() => void run(() => api.reload())}>
              Reload plugins
            </button>
            <button type="button" style={touch} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
