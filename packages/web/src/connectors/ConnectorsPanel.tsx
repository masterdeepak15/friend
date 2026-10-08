import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpConnectorsApi, parseEnv, parseHeaders, parseLines, type ConnectorList, type ConnectorView, type ConnectorsApi, type NewConnector, type Preset } from "./connectorsApi";

type Page = { name: "list" } | { name: "form"; preset: Preset | null } | { name: "pin"; connector: NewConnector; preset: Preset | null } | { name: "switch-on"; id: string; label: string };

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
export function ConnectorsPanel({ api = httpConnectorsApi, onClose }: { api?: ConnectorsApi; onClose: () => void }) {
  const [list, setList] = useState<ConnectorList | null>(null);
  const [page, setPage] = useState<Page>({ name: "list" });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  const frame = (children: React.ReactNode) => (
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
              <button type="button" style={touch} className="primary" disabled={(list?.connectors ?? []).some((c) => c.id === p.connector.id)} onClick={() => openForm(p)}>
                Add
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
