import { useCallback, useEffect, useRef, useState } from "react";
import { HoloCardList, paginate, pagingFor, type HoloCard } from "../orb/HoloCards";
import { HoloPanel } from "../orb/HoloPanel";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpConnectorsApi, parseEnv, parseHeaders, parseLines, type ConnectorList, type ConnectorView, type ConnectorsApi, type NewConnector, type Preset, type QuickCheck } from "./connectorsApi";

type Page =
  | { name: "list" }
  | { name: "form"; preset: Preset | null }
  | { name: "pin"; connector: NewConnector; preset: Preset | null }
  | { name: "switch-on"; id: string; label: string }
  | { name: "quick-check"; preset: Preset }
  | { name: "quick-help"; preset: Preset; check: QuickCheck }
  | { name: "quick-pin"; preset: Preset; mode: "install" | "connect"; check: QuickCheck }
  | { name: "quick-done"; preset: Preset; ok: boolean; lines: string[] };

const STATUS_TEXT: Record<ConnectorView["status"], string> = { off: "Off", connecting: "Connecting…", ready: "Ready", error: "Not working" };

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);

/**
 * Owner-opened panel: the outside programs and services Friend may use (Gmail, Chrome control, …). Adding or switching
 * one on needs the PIN, because it starts a program or reaches a service. The PIN pad is drawn by the client.
 */
export function ConnectorsPanel({ api = httpConnectorsApi, onClose, variant = "classic" }: { api?: ConnectorsApi; onClose: () => void; variant?: "classic" | "holo" }) {
  const [list, setList] = useState<ConnectorList | null>(null);
  const [page, setPage] = useState<Page>({ name: "list" });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [section, setSection] = useState<"connected" | "add">("connected");
  const [pageIdx, setPageIdx] = useState(0);
  const alive = useRef(true);

  // the form
  const [kind, setKind] = useState<"stdio" | "http">("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [secrets, setSecrets] = useState("");
  const [url, setUrl] = useState("");

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
    // a connector that is still starting changes by itself
    const t = setInterval(() => void refresh(), 4000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
  }, [refresh]);

  const run = async (job: () => Promise<string | void>) => {
    setError(null);
    setBusy(true);
    try {
      const msg = await job();
      if (!alive.current) return;
      if (msg) setNotice(msg);
      setPage({ name: "list" });
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

  /** One click: find out what the connector needs; if it is all there, go straight to the PIN, otherwise say what to install. */
  const startQuick = async (preset: Preset) => {
    setError(null);
    setNotice(null);
    setPage({ name: "quick-check", preset });
    try {
      const check = await api.quickCheck(preset.id);
      if (!alive.current) return;
      setPage(check.ready ? { name: "quick-pin", preset, mode: "connect", check } : { name: "quick-help", preset, check });
    } catch (e) {
      if (!alive.current) return;
      setError((e as Error).message);
      setPage({ name: "list" });
    }
  };

  const confirmQuick = async () => {
    if (page.name !== "quick-pin") return;
    const { preset, mode } = page;
    setError(null);
    setBusy(true);
    try {
      const lines: string[] = [];
      let ok = true;
      if (mode === "install") {
        const i = await api.quickInstall(preset.id, pin);
        lines.push(i.message);
        if (i.output && !i.ok) lines.push(i.output);
        ok = i.ok;
      }
      if (ok) {
        const c = await api.quickConnect(preset.id, pin);
        lines.push(c.message);
        ok = c.ok;
      }
      if (!alive.current) return;
      setPage({ name: "quick-done", preset, ok, lines });
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

  const openForm = (preset: Preset | null) => {
    setError(null);
    setNotice(null);
    setKind("stdio");
    setName(preset?.connector.name ?? "");
    setCommand(preset?.connector.command ?? "");
    setArgs((preset?.connector.args ?? []).join("\n"));
    setSecrets("");
    setUrl("");
    setPage({ name: "form", preset });
  };

  const toPin = () => {
    setError(null);
    try {
      const id = page.name === "form" && page.preset ? page.preset.connector.id : slug(name);
      if (!id) throw new Error("Give it a name.");
      const connector: NewConnector =
        kind === "stdio"
          ? { id, name: name.trim(), kind, command: command.trim(), args: parseLines(args), env: parseEnv(secrets) }
          : { id, name: name.trim(), kind, url: url.trim(), headers: parseHeaders(secrets) };
      if (connector.kind === "stdio" && !connector.command) throw new Error("Enter the program to start.");
      if (connector.kind === "http" && !connector.url) throw new Error("Enter the address of the server.");
      setPage({ name: "pin", connector, preset: page.name === "form" ? page.preset : null });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const confirm = () => {
    if (page.name === "pin") void run(async () => {
      const v = await api.add(page.connector, pin);
      return v.status === "ready" ? `${v.name} is connected with ${v.tools} tools.` : `${v.name} was saved but is not working yet: ${v.error ?? "unknown error"}`;
    });
    else if (page.name === "switch-on") void run(async () => {
      const v = await api.setEnabled(page.id, true, pin);
      return v.status === "ready" ? `${v.name} is on with ${v.tools} tools.` : `${v.name} did not start: ${v.error ?? "unknown error"}`;
    });
  };

  const frame = (children: React.ReactNode, glass: { title?: string; page?: ReturnType<typeof pagingFor>; help?: React.ReactNode } = {}) =>
    variant === "holo" ? (
      <HoloPanel label="Connectors" title={glass.title ?? "Connectors"} page={glass.page} help={glass.help} onDone={onClose}>
        {children}
      </HoloPanel>
    ) : (
      <div className="approval connectors glass" role="dialog" aria-label="Connectors" style={{ pointerEvents: "auto" }}>
        <div className="approval-head">
          <span className="approval-title">Connectors</span>
        </div>
        {children}
      </div>
    );
  const errorLine = error && (
    <p role="alert" className="auth-error">
      {error}
    </p>
  );

  if (page.name === "quick-check") return frame(<p className="auth-note">Checking {page.preset.name}…</p>);

  if (page.name === "quick-help") {
    const { preset, check } = page;
    return frame(
      <>
        <p className="auth-note connector-warning">{check.message}</p>
        <p className="auth-note">Easiest: let Friend install it for you in the background. You will only need your PIN, and then one step in Chrome.</p>
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" onClick={() => setPage({ name: "quick-pin", preset, mode: "install", check })}>
            Set it up for me
          </button>
          <button type="button" style={touch} onClick={() => void startQuick(preset)}>
            Check again
          </button>
          <button type="button" style={touch} onClick={() => setPage({ name: "list" })}>
            Back
          </button>
        </div>
        {check.installCommand && (
          <>
            <p className="auth-note">Or do it yourself: open a terminal and run</p>
            <pre className="connector-command">{check.installCommand}</pre>
          </>
        )}
        {check.manualStep && <p className="auth-note">{check.manualStep}</p>}
      </>,
    );
  }

  if (page.name === "quick-pin") {
    const { preset, mode } = page;
    const cmd = [preset.connector.command, ...preset.connector.args].join(" ");
    return frame(
      <>
        <p className="auth-note">
          {mode === "connect"
            ? `Friend will add ${preset.name} for you and start it. It runs: ${cmd}`
            : `Friend will install ${preset.name} for you in the background, then connect it. It runs: ${page.check.installCommand ?? ""}, without touching Claude's settings or Chrome's shortcuts. It copies a small helper and the Chrome extension into your home folder. This can take a minute.`}
        </p>
        <p className="auth-note">Enter your PIN to continue.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && void confirmQuick()} />
        {errorLine}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void confirmQuick()}>
            {busy ? (mode === "install" ? "Installing… this can take a minute" : "Connecting…") : mode === "install" ? "Install and connect" : "Connect"}
          </button>
          <button
            type="button"
            style={touch}
            disabled={busy}
            onClick={() => {
              setPin("");
              setError(null);
              setPage({ name: "list" });
            }}
          >
            Back
          </button>
        </div>
      </>,
    );
  }

  if (page.name === "quick-done") {
    return frame(
      <>
        {page.lines.map((l, i) => (
          <p key={i} className={`auth-note${i === 0 && !page.ok ? " connector-warning" : ""}`}>
            {l}
          </p>
        ))}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" onClick={() => setPage({ name: "list" })}>
            Done
          </button>
          {!page.ok && (
            <button type="button" style={touch} onClick={() => void startQuick(page.preset)}>
              Try again
            </button>
          )}
        </div>
      </>,
    );
  }

  if (page.name === "pin" || page.name === "switch-on") {
    const text =
      page.name === "pin"
        ? page.connector.kind === "stdio"
          ? `Friend will start this program on your PC: ${[page.connector.command, ...page.connector.args].join(" ")}`
          : `Friend will connect to ${page.connector.url.replace(/\?.*$/, "?…")}`
        : `Switch on ${page.label}? It starts the program or connects to the service.`;
    return frame(
      <>
        <p className="auth-note">{text}</p>
        <p className="auth-note">Enter your PIN to confirm.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && confirm()} />
        {errorLine}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={confirm}>
            {busy ? "Connecting…" : "Confirm"}
          </button>
          <button
            type="button"
            style={touch}
            onClick={() => {
              setPage(page.name === "pin" ? { name: "form", preset: page.preset } : { name: "list" });
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

  if (page.name === "form") {
    const preset = page.preset;
    return frame(
      <div className="connector-form">
        {preset && (
          <>
            <p className="auth-note">{preset.description}</p>
            <ol className="connector-steps">
              {preset.setup.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {preset.warning && <p className="auth-note connector-warning">{preset.warning}</p>}
          </>
        )}
        <label className="settings-field">
          <span>Name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        {!preset && (
          <label className="settings-field">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as "stdio" | "http")}>
              <option value="stdio">A program on this PC</option>
              <option value="http">A server by address</option>
            </select>
          </label>
        )}
        {kind === "stdio" ? (
          <>
            <label className="settings-field">
              <span>Program</span>
              <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </label>
            <label className="settings-field">
              <span>Arguments (one per line)</span>
              <textarea rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\nsome-mcp-server"} />
            </label>
            <label className="settings-field">
              <span>Secret variables (NAME=value, one per line)</span>
              <textarea rows={2} value={secrets} onChange={(e) => setSecrets(e.target.value)} autoComplete="off" placeholder="Leave empty if it needs none" />
              <small className="auth-note">Saved privately on this PC and never shown again.</small>
            </label>
          </>
        ) : (
          <>
            <label className="settings-field">
              <span>Address</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…  or  http://127.0.0.1:8766/mcp" />
              <small className="auth-note">Plain http is only allowed for a server on this PC.</small>
            </label>
            <label className="settings-field">
              <span>Secret headers (Name: value, one per line)</span>
              <textarea rows={2} value={secrets} onChange={(e) => setSecrets(e.target.value)} autoComplete="off" />
            </label>
          </>
        )}
        {errorLine}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" onClick={toPin}>
            Next
          </button>
          <button type="button" style={touch} onClick={() => setPage({ name: "list" })}>
            Back
          </button>
        </div>
      </div>,
    );
  }

  if (variant === "holo") {
    const connected = list?.connectors ?? [];
    const presets = list?.presets ?? [];
    const BADGE: Record<ConnectorView["status"], "on" | "off" | "warn" | "error"> = { off: "off", connecting: "warn", ready: "on", error: "error" };
    const connectedCards: HoloCard[] = connected.map((c) => ({
      key: c.id,
      name: c.name,
      badge: BADGE[c.status],
      badgeText: STATUS_TEXT[c.status],
      ...(c.status === "ready" ? { meta: `${c.tools} tools` } : {}),
      note: `${c.error ? c.error : c.target}${c.secret ? " · secret saved" : ""}`,
      noteClass: c.error ? "auth-error" : "auth-note",
      actions: [
        { label: c.enabled ? "Turn off" : "Turn on", disabled: busy, onClick: () => (c.enabled ? void run(async () => { await api.setEnabled(c.id, false); }) : setPage({ name: "switch-on", id: c.id, label: c.name })) },
        ...(c.enabled ? [{ label: "Reload", disabled: busy, onClick: () => void run(async () => { await api.reload(c.id); }) }] : []),
        { label: "Remove", kind: "danger" as const, disabled: busy, onClick: () => void run(async () => { await api.remove(c.id); }) },
      ],
    }));
    const addCards: HoloCard[] = [
      ...presets.map((p): HoloCard => ({
        key: p.id,
        name: p.name,
        note: p.description,
        noteClass: "auth-note",
        actions: [{ label: p.quick ? "Connect" : "Add", kind: "primary", disabled: connected.some((c) => c.id === p.connector.id), onClick: () => (p.quick ? void startQuick(p) : openForm(p)) }],
      })),
      { key: "something-else", name: "Something else", note: "Any MCP program or server.", noteClass: "auth-note", actions: [{ label: "Add", onClick: () => openForm(null) }] },
    ];
    const cards = section === "connected" ? connectedCards : addCards;
    const { here, at, pages } = paginate(cards, pageIdx);
    return frame(
      <>
        {errorLine}
        {notice && <p className="auth-note">{notice}</p>}
        <HoloCardList
          tabs={[
            { id: "connected" as const, label: "Connected", count: connectedCards.length },
            { id: "add" as const, label: "Add", count: addCards.length },
          ]}
          active={section}
          onTab={(id) => {
            setSection(id);
            setPageIdx(0);
          }}
          cards={here}
          empty="Nothing connected yet. Add one on the Add tab."
          ready={!!list}
        />
      </>,
      { page: pagingFor(at, pages, setPageIdx), help: <>Outside programs and services Friend may use. Adding or switching one on needs your <b>PIN</b>.</> },
    );
  }

  return frame(
    <>
      {errorLine}
      {notice && <p className="auth-note">{notice}</p>}
      <h4 className="plugins-heading">Connected</h4>
      {list && list.connectors.length === 0 && <p className="auth-note">Nothing connected yet. Add one below.</p>}
      <ul className="plugin-list">
        {(list?.connectors ?? []).map((c) => (
          <li key={c.id}>
            <div className="plugin-info">
              <strong>{c.name}</strong> <small className={`conn-status conn-${c.status}`}>{STATUS_TEXT[c.status]}{c.status === "ready" ? ` · ${c.tools} tools` : ""}</small>
              <div className="auth-note">
                {c.error ? `${c.error}` : c.target}
                {c.secret ? " · secret saved" : ""}
              </div>
            </div>
            <div className="plugin-actions">
              <button
                type="button"
                style={touch}
                disabled={busy}
                onClick={() => (c.enabled ? void run(async () => { await api.setEnabled(c.id, false); }) : setPage({ name: "switch-on", id: c.id, label: c.name }))}
              >
                {c.enabled ? "Turn off" : "Turn on"}
              </button>
              {c.enabled && (
                <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => { await api.reload(c.id); })}>
                  Reload
                </button>
              )}
              <button type="button" style={touch} className="danger" disabled={busy} onClick={() => void run(async () => { await api.remove(c.id); })}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      <h4 className="plugins-heading">Add</h4>
      <ul className="plugin-list">
        {(list?.presets ?? []).map((p) => (
          <li key={p.id}>
            <div className="plugin-info">
              <strong>{p.name}</strong>
              <div className="auth-note">{p.description}</div>
            </div>
            <div className="plugin-actions">
              <button type="button" style={touch} className="primary" disabled={(list?.connectors ?? []).some((c) => c.id === p.connector.id)} onClick={() => (p.quick ? void startQuick(p) : openForm(p))}>
                {p.quick ? "Connect" : "Add"}
              </button>
            </div>
          </li>
        ))}
        <li>
          <div className="plugin-info">
            <strong>Something else</strong>
            <div className="auth-note">Any MCP program or server.</div>
          </div>
          <div className="plugin-actions">
            <button type="button" style={touch} onClick={() => openForm(null)}>
              Add
            </button>
          </div>
        </li>
      </ul>
      <div className="approval-actions">
        <button type="button" style={touch} onClick={onClose}>
          Close
        </button>
      </div>
    </>,
  );
}
