import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";

export interface SoulInfo {
  text: string;
  isDefault: boolean;
  max: number;
  versions: { at: number; chars: number }[];
}

export interface SoulApi {
  get(): Promise<SoulInfo>;
  /** Needs the PIN: it changes who the assistant is. */
  save(text: string, pin: string): Promise<SoulInfo>;
  /** Needs the PIN. */
  restore(to: "previous" | "default", pin: string): Promise<SoulInfo>;
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
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const httpSoulApi: SoulApi = {
  get: () => call("/api/soul"),
  save: (text, pin) => call("/api/soul", send("PUT", { text, pin })),
  restore: (to, pin) => call("/api/soul/restore", send("POST", { to, pin })),
};

type Ask = { kind: "save" } | { kind: "restore"; to: "previous" | "default" };

/**
 * The assistant's soul (soul.md in memory): who it is, in the owner's words. It can be rewritten here or by asking the assistant; either way
 * the owner's PIN is needed, and the version it replaced is kept so a change can be taken back.
 */
export function SoulTab({ api = httpSoulApi }: { api?: SoulApi }) {
  const [info, setInfo] = useState<SoulInfo | null>(null);
  const [text, setText] = useState("");
  const [asking, setAsking] = useState<Ask | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const i = await api.get();
      if (!alive.current) return;
      setInfo(i);
      setText(i.text);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  const run = async () => {
    if (!asking) return;
    setBusy(true);
    setError(null);
    try {
      const i = asking.kind === "save" ? await api.save(text, pin) : await api.restore(asking.to, pin);
      if (!alive.current) return;
      setInfo(i);
      setText(i.text);
      setNote(asking.kind === "save" ? "Saved. The assistant uses it from its next reply." : asking.to === "default" ? "Back to the default soul." : "Back to the earlier soul.");
      setAsking(null);
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
        <p className="auth-note">{asking.kind === "save" ? "Enter your PIN to change who the assistant is." : asking.to === "default" ? "Enter your PIN to put the original default soul back." : "Enter your PIN to bring back the earlier soul."}</p>
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

  const max = info?.max ?? 3000;
  const changed = !!info && text.trim() !== info.text.trim();
  return (
    <>
      <h4 className="plugins-heading">Soul</h4>
      <p className="auth-note">Who your assistant is: its purpose, character, manner, gender and how it speaks to you. It is read on every request and kept in memory as soul.md. You can change it here, or just tell the assistant ("be more direct", "you are my study coach"). Its safety rules and your approvals are not part of it and cannot be loosened by it.</p>
      <textarea aria-label="Soul" className="soul-text" rows={16} value={text} maxLength={max} onChange={(e) => setText(e.target.value)} style={{ width: "100%", fontFamily: "inherit" }} />
      <p className="auth-note">
        {text.length} of {max} characters{info?.isDefault ? ". This is the default soul." : "."}
      </p>
      {note && <p role="status">{note}</p>}
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" disabled={busy || !changed || !text.trim()} onClick={() => setAsking({ kind: "save" })}>
          Save soul
        </button>
        <button type="button" style={touch} disabled={busy || !changed} onClick={() => setText(info?.text ?? "")}>
          Undo my edits
        </button>
        <button type="button" style={touch} disabled={busy || !info || info.versions.length === 0} onClick={() => setAsking({ kind: "restore", to: "previous" })}>
          Bring back the earlier soul
        </button>
        <button type="button" style={touch} disabled={busy || !info || info.isDefault} onClick={() => setAsking({ kind: "restore", to: "default" })}>
          Reset to default
        </button>
      </div>
    </>
  );
}
