import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import type { IntegrationEntry } from "./pluginsApi";

export interface ChromeInfo {
  state: IntegrationEntry["state"];
  /** What is going on, or what to do next, in one line. */
  detail: string;
  /** The folder to load in chrome://extensions, once Chrome control is set up. */
  extensionFolder: string | null;
}

export interface ChromeAccessInfo {
  /** The owner has allowed other PCs to use Chrome control through Friend's own address. */
  remote: boolean;
  /** For MCP clients on other PCs (Claude Code, Claude Desktop...). */
  mcpUrl: string;
  /** What to type as the server in the extension's popup on another PC. */
  extensionAddress: string;
  /** Where the extension can be downloaded as a zip, or null when this Friend carries none. */
  extensionZip: string | null;
}

export interface ChromeApi {
  info(): Promise<ChromeInfo>;
  access(): Promise<ChromeAccessInfo>;
  /** Allowing needs the PIN; stopping does not. */
  setRemote(enabled: boolean, pin?: string): Promise<void>;
  /** Chrome control's secret key. Needs the PIN. */
  revealKey(pin: string): Promise<string>;
  /** Sets Chrome control up (its helper and the extension folder) from the copy that comes with Friend. */
  setUp(pin: string): Promise<{ ok: boolean; message: string }>;
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
  if (!res.ok) throw new Error(body.error ?? (res.status === 401 ? "Please sign in again." : res.status === 403 ? "Incorrect PIN" : `The request failed (${res.status}).`));
  return body as T;
}

export const httpChromeApi: ChromeApi = {
  info: async () => {
    const r = await call<{ integrations?: (IntegrationEntry & { settings?: Record<string, string | boolean> })[] }>("/api/plugins");
    const c = r.integrations?.find((i) => i.id === "chrome");
    const folder = c?.settings?.extensionFolder;
    return { state: c?.state ?? "not-installed", detail: c?.detail ?? "", extensionFolder: typeof folder === "string" && folder ? folder : null };
  },
  setUp: (pin) => call("/api/connectors/quick/chrome/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) }),
  access: () => call<ChromeAccessInfo>("/api/plugins/chrome/access"),
  setRemote: async (enabled, pin) => {
    await call("/api/plugins/chrome/remote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, ...(pin ? { pin } : {}) }) });
  },
  revealKey: async (pin) => (await call<{ token: string }>("/api/plugins/chrome/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) })).token,
};

/** A small read-only box with a Copy button. */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label className="settings-field">
      <span>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        <input type="text" readOnly value={value} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </label>
  );
}

type Ask = "setup" | "allow" | "key";

/**
 * The Configure page of Chrome control, which comes with Friend: where the extension is (to load in Chrome, the one step nobody
 * can do for the owner) and how it stands, refreshed while the page is open. Nothing is typed here, so there is nothing to save.
 */
export function ChromeForm({ api = httpChromeApi, pollMs = 3000 }: { api?: ChromeApi; pollMs?: number }) {
  const [info, setInfo] = useState<ChromeInfo | null>(null);
  const [access, setAccess] = useState<ChromeAccessInfo | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [i, a] = await Promise.all([api.info(), api.access()]);
      if (!alive.current) return;
      setInfo(i);
      setAccess(a);
    } catch {
      /* the next look will try again */
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : null;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [refresh, pollMs]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (asking === "setup") {
        const r = await api.setUp(pin);
        if (!alive.current) return;
        setNote(r.message);
      } else if (asking === "allow") {
        await api.setRemote(true, pin);
      } else if (asking === "key") {
        const k = await api.revealKey(pin);
        if (!alive.current) return;
        setKey(k);
      }
      if (!alive.current) return;
      setAsking(null);
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

  if (asking) {
    return (
      <>
        <p className="auth-note">{asking === "setup" ? "Enter your PIN to set up Chrome control." : asking === "allow" ? "Enter your PIN to allow other PCs to use Chrome control through Friend." : "Enter your PIN to show the key."}</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && void run()} />
        {error && (
          <p role="alert" className="auth-error">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={() => void run()}>
            Continue
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

  return (
    <div className="settings-section">
      {info?.detail && (
        <p className="auth-note" style={{ marginBottom: 10 }}>
          {info.detail}
        </p>
      )}
      {info?.extensionFolder && (
        <label className="settings-field">
          <span>Folder to load in Chrome (chrome://extensions, Developer mode, Load unpacked)</span>
          <div style={{ display: "flex", gap: 6 }}>
            <input type="text" readOnly value={info.extensionFolder} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(info.extensionFolder ?? "").then(() => setCopied(true), () => {});
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </label>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} className={info?.extensionFolder ? undefined : "primary"} onClick={() => setAsking("setup")}>
          {info?.extensionFolder ? "Set up again" : "Set up Chrome control"}
        </button>
      </div>
      {note && <p className="auth-note">{note}</p>}
      {access && info?.extensionFolder && (
        <>
          <h4 className="plugins-heading">From another PC</h4>
          {access.extensionZip && (
            <p className="auth-note">
              <a href={access.extensionZip} download="friend-chrome-extension.zip">
                Download the extension
              </a>{" "}
              to install it in Chrome on another PC: unzip it, open chrome://extensions, turn on Developer mode, press Load unpacked and choose the unzipped folder.
            </p>
          )}
          {!access.remote ? (
            <div className="approval-actions">
              <button type="button" style={touch} onClick={() => setAsking("allow")}>
                Allow other PCs
              </button>
            </div>
          ) : (
            <>
              <CopyField label="Server to type in the extension's popup on the other PC" value={access.extensionAddress} />
              <CopyField label="MCP address for apps on other PCs (Claude Code, Claude Desktop). Send the key as: Authorization: Bearer KEY" value={access.mcpUrl} />
              {/^(ws|http):\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(access.extensionAddress) && (
                <p className="auth-note">These use the address you opened Friend with, and another PC cannot reach 127.0.0.1. Open Friend by its network or public address and these will show that one.</p>
              )}
              {key ? <CopyField label="The key (paste it in the extension's popup)" value={key} /> : null}
              <div className="approval-actions">
                {!key && (
                  <button type="button" style={touch} onClick={() => setAsking("key")}>
                    Show the key
                  </button>
                )}
                <button
                  type="button"
                  style={touch}
                  onClick={() => {
                    setKey(null);
                    void api.setRemote(false).then(() => refresh(), (e: Error) => setError(e.message));
                  }}
                >
                  Stop allowing other PCs
                </button>
              </div>
            </>
          )}
        </>
      )}
      <small className="auth-note">
        Chrome does not allow programs to add an extension by themselves, so loading the folder above is the one step you do. While the extension is on, Friend can act as you on the sites it allows; every action still asks for your approval, and
        in the extension's popup you can limit it to certain sites.
      </small>
    </div>
  );
}
