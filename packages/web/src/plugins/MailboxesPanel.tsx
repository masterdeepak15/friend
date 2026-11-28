import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpMailApi, type Handlers, type Ladder, type MailAccountInput, type MailAccountView, type MailApi } from "./mailApi";

type Draft = { id?: number; name: string; address: string; username: string; password: string; imap: MailAccountInput["imap"]; smtp: MailAccountInput["smtp"]; owners: string[]; systems: string[] };
type Step = { kind: "list" } | { kind: "form"; draft: Draft } | { kind: "rules"; account: MailAccountView; ladder: Ladder } | { kind: "pin"; what: "add" | "update" | "rules" | "remove"; draft?: Draft; account?: MailAccountView; ladder?: Ladder };

const PRESETS: { label: string; imap: Draft["imap"]; smtp: Draft["smtp"]; help: string }[] = [
  { label: "Gmail", imap: { host: "imap.gmail.com", port: 993, tls: true }, smtp: { host: "smtp.gmail.com", port: 465, secure: true }, help: "Use an app password (Google account, Security, 2-step verification, App passwords). IMAP must be on." },
  { label: "Microsoft 365 / Outlook", imap: { host: "outlook.office365.com", port: 993, tls: true }, smtp: { host: "smtp.office365.com", port: 587, secure: false }, help: "Use an app password, or ask your admin to allow IMAP and SMTP sign-in for this mailbox." },
  { label: "Other", imap: { host: "", port: 993, tls: true }, smtp: { host: "", port: 465, secure: true }, help: "The IMAP and SMTP server names and ports are in your mail provider's help." },
];
const KINDS: { key: keyof Ladder; label: string }[] = [
  { key: "send", label: "New mail" },
  { key: "reply", label: "Replies" },
  { key: "forward", label: "Forwarding" },
];
const blank = (): Draft => ({ name: "", address: "", username: "", password: "", imap: { host: "", port: 993, tls: true }, smtp: { host: "", port: 465, secure: true }, owners: [], systems: [] });

const STATUS: Record<MailAccountView["status"], string> = { new: "connecting", online: "online", "needs-sign-in": "needs sign-in", error: "trouble connecting" };

function Lines({ label, help, value, onChange }: { label: string; help: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <label className="settings-field">
      <span>{help}</span>
      <textarea
        aria-label={label}
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split("\n").map((l) => l.trim()).filter(Boolean));
        }}
      />
    </label>
  );
}

/**
 * The mailboxes Friend can read and write from: the list with how each is doing, adding one (its login is tried before it is kept),
 * what Friend may send by itself, and removing. Everything that changes something asks for the PIN, and the password is never shown again.
 */
export function MailboxesPanel({ api = httpMailApi, pollMs = 5000, onBack }: { api?: MailApi; pollMs?: number; onBack?: () => void }) {
  const [accounts, setAccounts] = useState<MailAccountView[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [preset, setPreset] = useState(PRESETS[2]!.help);
  const [handlers, setHandlers] = useState<Handlers | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const l = await api.list();
      if (alive.current) setAccounts(l);
      const h = await api.handlers?.().catch(() => null);
      if (alive.current && h) setHandlers(h);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const t = pollMs > 0 ? setInterval(() => void refresh(), pollMs) : null;
    return () => {
      alive.current = false;
      if (t) clearInterval(t);
    };
  }, [refresh, pollMs]);

  const run = async (job: () => Promise<void>, keepPin = false) => {
    setError(null);
    setBusy(true);
    try {
      await job();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        if (!keepPin) setPin("");
      }
    }
  };

  const input = (d: Draft): MailAccountInput => ({ name: d.name.trim(), address: d.address.trim(), username: (d.username || d.address).trim(), imap: d.imap, smtp: d.smtp, owners: d.owners, systems: d.systems });

  const confirm = () => {
    if (step.kind !== "pin") return;
    void run(async () => {
      if (step.what === "add" && step.draft) await api.add(input(step.draft), step.draft.password, pin);
      else if (step.what === "update" && step.draft?.id !== undefined) await api.update(step.draft.id, input(step.draft), step.draft.password || undefined, pin);
      else if (step.what === "rules" && step.account && step.ladder) await api.setLadder(step.account.id, step.ladder, pin);
      else if (step.what === "remove" && step.account) await api.remove(step.account.id, pin);
      setStep({ kind: "list" });
      await refresh();
    });
  };

  const err = error && (
    <p role="alert" className="auth-error">
      {error}
    </p>
  );
  const back = (
    <button type="button" style={touch} onClick={() => (step.kind === "list" ? onBack?.() : (setStep({ kind: "list" }), setError(null), void refresh()))}>
      Back
    </button>
  );

  if (step.kind === "pin") {
    const name = step.draft?.name || step.account?.name || "";
    const words = { add: `Add the mailbox "${name}"? Its login is tried first.`, update: `Save the changes to "${name}"?`, rules: `Save what Friend may send by itself from "${name}"?`, remove: `Remove the mailbox "${name}" and its saved password? Mail already on the server stays there.` }[step.what];
    return (
      <div className="pc-panel">
        <p className="auth-note">{words} Enter your PIN to confirm.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && confirm()} />
        {err}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={confirm}>
            Confirm
          </button>
          <button type="button" style={touch} onClick={() => { setStep(step.what === "add" || step.what === "update" ? { kind: "form", draft: step.draft! } : { kind: "list" }); setPin(""); setError(null); }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === "form") {
    const d = step.draft;
    const set = (p: Partial<Draft>) => setStep({ kind: "form", draft: { ...d, ...p } });
    const editing = d.id !== undefined;
    const ready = d.name.trim() && d.address.trim() && (editing || d.password) && d.imap.host && d.smtp.host && d.owners.length > 0;
    return (
      <div className="pc-panel">
        {!editing && (
          <div className="approval-actions" role="group" aria-label="Mail provider">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" style={touch} onClick={() => { set({ imap: p.imap, smtp: p.smtp }); setPreset(p.help); }}>
                {p.label}
              </button>
            ))}
          </div>
        )}
        <p className="auth-note">{preset}</p>
        <label className="settings-field"><span>Name (how Friend calls this mailbox)</span><input aria-label="Name of the mailbox" value={d.name} maxLength={60} placeholder="Support" onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="settings-field"><span>Email address</span><input aria-label="Email address" value={d.address} placeholder="support@example.com" onChange={(e) => set({ address: e.target.value })} /></label>
        <label className="settings-field"><span>Login name (leave empty when it is the address)</span><input aria-label="Login name" value={d.username} onChange={(e) => set({ username: e.target.value })} /></label>
        <label className="settings-field">
          <span>{editing ? "Password (leave empty to keep the saved one)" : "Password"}</span>
          <input aria-label="Password" type="password" autoComplete="new-password" value={d.password} onChange={(e) => set({ password: e.target.value })} />
        </label>
        <label className="settings-field"><span>IMAP server (reading)</span><input aria-label="IMAP server" value={d.imap.host} onChange={(e) => set({ imap: { ...d.imap, host: e.target.value } })} /></label>
        <label className="settings-field"><span>IMAP port</span><input aria-label="IMAP port" type="number" value={d.imap.port} onChange={(e) => set({ imap: { ...d.imap, port: Number(e.target.value) } })} /></label>
        <label className="settings-field"><span>SMTP server (sending)</span><input aria-label="SMTP server" value={d.smtp.host} onChange={(e) => set({ smtp: { ...d.smtp, host: e.target.value } })} /></label>
        <label className="settings-field"><span>SMTP port</span><input aria-label="SMTP port" type="number" value={d.smtp.port} onChange={(e) => set({ smtp: { ...d.smtp, port: Number(e.target.value), secure: Number(e.target.value) === 465 } })} /></label>
        <Lines label="Your addresses" help="Your own address(es), one per line. Only mail proven to come from one of these can give Friend an order." value={d.owners} onChange={(owners) => set({ owners })} />
        <Lines label="System senders" help="Senders you trust to send information, such as a monitoring service (an address, or @domain). They can never give an order." value={d.systems} onChange={(systems) => set({ systems })} />
        {err}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={!ready} onClick={() => setStep({ kind: "pin", what: editing ? "update" : "add", draft: d })}>
            Continue
          </button>
          {back}
        </div>
      </div>
    );
  }

  if (step.kind === "rules") {
    const { account, ladder } = step;
    return (
      <div className="pc-panel">
        <p className="auth-note">What may Friend send from {account.name} without asking you? Everything asks until you change it. A mail to someone this mailbox has not dealt with before always asks, and mail that came from someone else always asks.</p>
        {KINDS.map((k) => (
          <label key={k.key} className="settings-check">
            {k.label}{" "}
            <select aria-label={k.label} value={ladder[k.key]} onChange={(e) => setStep({ kind: "rules", account, ladder: { ...ladder, [k.key]: e.target.value as "ask" | "auto" } })}>
              <option value="ask">ask me every time</option>
              <option value="auto">send by itself (known people only)</option>
            </select>
          </label>
        ))}
        {err}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" onClick={() => setStep({ kind: "pin", what: "rules", account, ladder })}>
            Save
          </button>
          {back}
        </div>
      </div>
    );
  }

  return (
    <div className="pc-panel">
      {accounts && accounts.length === 0 && <p className="auth-note">No mailboxes yet. Press Add a mailbox. Friend then reads its new mail; only mail from you can give it an order.</p>}
      <ul className="pc-list">
        {(accounts ?? []).map((a) => (
          <li key={a.id}>
            <b>{a.name}</b> <small>{a.address}</small> <span className={`pc-state ${a.status}`}>{STATUS[a.status]}</span>
            {a.statusDetail && <p className="auth-note">{a.statusDetail}</p>}
            <p className="auth-note">Orders from: {a.owners.join(", ") || "nobody yet"}</p>
            {handlers && handlers.workers.length > 0 && api.setHandler && (
              <label className="auth-note">
                Handled by{" "}
                <select
                  aria-label={`Handled by, ${a.name}`}
                  value={handlers.routes.find((r) => r.kind === "mail" && r.key === String(a.id))?.worker ?? ""}
                  onChange={(e) => void run(async () => {
                    await api.setHandler!(a.id, e.target.value || null);
                    await refresh();
                  })}
                >
                  <option value="">The assistant</option>
                  {handlers.workers.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} (crew, {w.role})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="approval-actions">
              <button type="button" style={touch} onClick={() => setStep({ kind: "form", draft: { id: a.id, name: a.name, address: a.address, username: a.username === a.address ? "" : a.username, password: "", imap: a.imap, smtp: a.smtp, owners: a.owners, systems: a.systems } })}>
                Change
              </button>
              <button type="button" style={touch} onClick={() => setStep({ kind: "rules", account: a, ladder: a.ladder })}>
                What it may send
              </button>
              <button
                type="button"
                style={touch}
                disabled={busy}
                onClick={() => void run(async () => {
                  const r = await api.test(a.id);
                  setNote(r.ok ? `${a.name}: the login works.` : `${a.name}: ${r.error ?? "the login failed."}`);
                  await refresh();
                })}
              >
                Test login
              </button>
              <button type="button" style={touch} onClick={() => setStep({ kind: "pin", what: "remove", account: a })}>
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
      {note && <p className="auth-note" role="status">{note}</p>}
      {err}
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" onClick={() => { setStep({ kind: "form", draft: blank() }); setNote(null); setPreset(PRESETS[2]!.help); }}>
          Add a mailbox
        </button>
        {back}
      </div>
    </div>
  );
}
