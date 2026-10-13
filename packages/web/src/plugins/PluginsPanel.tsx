import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HoloCardList, paginate, pagingFor } from "../orb/HoloCards";
import { HoloPanel } from "../orb/HoloPanel";
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

/** In the glass panel each state has its own colour. */
const BADGE: Record<IntegrationEntry["state"], "on" | "off" | "warn" | "error"> = {
  "not-installed": "off",
  "needs-setup": "warn",
  off: "off",
  connecting: "warn",
  online: "on",
  error: "error",
};

/** What the install card offers for an integration: it looks like any other catalog plugin. */
const asOffer = (i: IntegrationEntry): CatalogPlugin => ({ id: i.id, name: i.name, version: "", description: i.description, tools: 0, skills: 0, error: null, installed: false });

interface Action {
  label: string;
  onClick: () => void;
  kind?: "primary" | "danger";
  disabled?: boolean;
}

/** One plugin or integration, in either list: what it is called, how it is doing, and what can be done to it. */
interface Entry {
  key: string;
  integrationId?: string;
  name: string;
  small: string;
  note: string;
  noteClass: "auth-note" | "auth-error";
  badge?: "on" | "off" | "warn" | "error";
  /** The words in the badge of the glass card (the classic list shows `small` instead). */
  badgeText?: string;
  actions: Action[];
}

type Section = "installed" | "available";

/**
 * Owner-opened panel: see, add, set up, switch and remove plugins. That includes the built-in integrations (Telegram,
 * WhatsApp and SMS), which get a Configure page once they are installed. Adding or switching on needs the PIN.
 * The glass variant shows Installed and Available as two tabs of cards, six to a page, paged with the arrows.
 */
export function PluginsPanel({ api = httpPluginsApi, onClose, initialConfigure, variant = "classic" }: { api?: PluginsApi; onClose: () => void; initialConfigure?: string; variant?: "classic" | "holo" }) {
  const [list, setList] = useState<PluginList | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(initialConfigure ?? null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>("installed");
  const [pageIdx, setPageIdx] = useState(0);
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

  const toggle = (id: string, name: string, enabled: boolean): Action => ({
    label: enabled ? "Turn off" : "Turn on",
    disabled: busy,
    onClick: () => (enabled ? void run(() => api.setEnabled(id, false, undefined)) : setPending({ kind: "enable", id, name })),
  });
  const remove = (id: string): Action => ({ label: "Remove", kind: "danger", disabled: busy, onClick: () => void run(() => api.remove(id)) });

  const installed: Entry[] = [
    ...installedIntegrations.map(
      (i): Entry => ({
        key: i.id,
        integrationId: i.id,
        name: i.name,
        small: STATE_WORD[i.state],
        note: i.detail,
        noteClass: i.state === "error" ? "auth-error" : "auth-note",
        badge: BADGE[i.state],
        badgeText: STATE_WORD[i.state] || "Off",
        actions: [{ label: "Configure", kind: "primary", disabled: busy, onClick: () => setConfiguring(i.id) }, toggle(i.id, i.name, i.enabled), remove(i.id)],
      }),
    ),
    ...(list?.installed ?? []).map(
      (p): Entry => ({
        key: p.id,
        name: p.name,
        small: p.version,
        note: p.error ? `This plugin cannot be used: ${p.error}` : `${plural(p.skills.length, "skill")}, ${plural(p.tools.length, "tool")}${p.enabled ? "" : " (off)"}`,
        noteClass: "auth-note",
        badge: p.error ? "error" : p.enabled ? "on" : "off",
        badgeText: p.error ? "Error" : p.enabled ? "On" : "Off",
        actions: [toggle(p.id, p.name, p.enabled), remove(p.id)],
      }),
    ),
  ];
  const available: Entry[] = [
    ...offeredIntegrations.map(
      (i): Entry => ({
        key: i.id,
        integrationId: i.id,
        name: i.name,
        small: "integration",
        note: i.description,
        noteClass: "auth-note",
        actions: [{ label: "Install", kind: "primary", disabled: busy, onClick: () => setPending({ kind: "install", plugin: asOffer(i), integration: true }) }],
      }),
    ),
    ...offers.map(
      (c): Entry => ({
        key: c.id,
        name: c.name,
        small: c.version,
        note: c.error ? `Cannot be installed: ${c.error}` : `${c.description} (${plural(c.skills, "skill")}, ${plural(c.tools, "tool")})`,
        noteClass: "auth-note",
        actions: [{ label: "Install", kind: "primary", disabled: busy || !!c.error, onClick: () => setPending({ kind: "install", plugin: c }) }],
      }),
    ),
  ];

  const errorLine = error && (
    <p role="alert" className="auth-error">
      {error}
    </p>
  );

  const pinStep = pending && (
    <>
      <p className="auth-note">
        {pending.kind === "install"
          ? pending.integration
            ? `Install ${pending.plugin.name}? It connects Friend to an outside service, and you set it up afterwards. Enter your PIN to confirm.`
            : `Install ${pending.plugin.name}? ${pending.plugin.tools > 0 ? "Its tools run in a Docker sandbox with no network and no access to your files, and ask for your approval every time. " : ""}Enter your PIN to confirm.`
          : `Switch on ${pending.name}? Enter your PIN to confirm.`}
      </p>
      <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && confirm()} />
      {errorLine}
      <div className={variant === "holo" ? "holo-actions" : "approval-actions"}>
        <button type="button" style={touch} className={variant === "holo" ? "holo-btn" : "primary"} disabled={busy || pin.length < 6} onClick={confirm}>
          Confirm
        </button>
        <button
          type="button"
          style={touch}
          className={variant === "holo" ? "holo-btn quiet" : undefined}
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
  );

  const configure = shown && (
    <IntegrationConfig
      integration={shown}
      onBack={() => {
        setConfiguring(null);
        void refresh();
      }}
    />
  );

  // ---------------------------------------------------------------- the glass panel

  if (variant === "holo") {
    const entries = section === "installed" ? installed : available;
    const { here, at, pages } = paginate(entries, pageIdx);
    const inList = !pending && !shown;
    const body: ReactNode = pending ? (
      pinStep
    ) : shown ? (
      configure
    ) : (
      <>
        {errorLine}
        <HoloCardList
          tabs={[
            { id: "installed" as Section, label: "Installed", count: installed.length },
            { id: "available" as Section, label: "Available", count: available.length },
          ]}
          active={section}
          onTab={(id) => {
            setSection(id);
            setPageIdx(0);
          }}
          cards={here.map((e) => ({ ...e, meta: e.badge ? (e.integrationId || !e.small ? undefined : `version ${e.small}`) : e.small || undefined }))}
          empty={section === "installed" ? "Nothing installed yet." : "Everything in the catalog is installed."}
          ready={!!list}
        />
      </>
    );
    return (
      <HoloPanel
        label="Plugins"
        title={pending ? "Confirm with PIN" : shown ? shown.name : "Plugins"}
        {...(inList && pages > 1 ? { page: pagingFor(at, pages, setPageIdx)! } : {})}
        help={inList ? <>Turn plugins on or off, set them up, or install more. Installing and switching on need your <b>PIN</b>.</> : undefined}
        extra={
          inList ? (
            <button type="button" className="holo-btn quiet" disabled={busy} onClick={() => void run(() => api.reload())}>
              Reload plugins
            </button>
          ) : undefined
        }
        onDone={onClose}
      >
        {body}
      </HoloPanel>
    );
  }

  // ---------------------------------------------------------------- the classic panel

  const item = (e: Entry) => (
    <li key={e.key} {...(e.integrationId ? { "data-integration": e.integrationId } : {})}>
      <div className="plugin-info">
        <strong>{e.name}</strong> <small>{e.small}</small>
        <div className={e.noteClass}>{e.note}</div>
      </div>
      <div className="plugin-actions">
        {e.actions.map((a) => (
          <button key={a.label} type="button" style={touch} className={a.kind} disabled={a.disabled} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
    </li>
  );

  return (
    <div className="approval plugins glass" role="dialog" aria-label="Plugins" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Plugins</span>
      </div>

      <div className="plugins-body">
        {pending ? (
          pinStep
        ) : shown ? (
          configure
        ) : (
          <>
            {errorLine}
            <h4 className="plugins-heading">Installed</h4>
            {list && installed.length === 0 && <p className="auth-note">Nothing installed yet.</p>}
            <ul className="plugin-list">{installed.map(item)}</ul>

            <h4 className="plugins-heading">Available</h4>
            {list && available.length === 0 && <p className="auth-note">Everything in the catalog is installed.</p>}
            <ul className="plugin-list">{available.map(item)}</ul>
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
    </div>
  );
}
