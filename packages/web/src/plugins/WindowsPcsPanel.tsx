import { NO_PC_PERMISSIONS, type PcPermissions } from "@friend/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { PinPad } from "../overlay/PinPad";
import { touch } from "../overlay/touch";
import { httpPcsApi, type AddedPc, type PcView, type PcsApi } from "./pcsApi";

type Step = { kind: "list" } | { kind: "add" } | { kind: "added"; added: AddedPc } | { kind: "perms"; pc: PcView } | { kind: "pin"; what: "add" | "perms" | "revoke" | "remove" | "reissue"; pc?: PcView; name?: string; permissions: PcPermissions };

const SWITCHES: { key: "control" | "screen" | "shell" | "process" | "registry"; label: string; help: string }[] = [
  { key: "control", label: "Control the screen", help: "look at it, move the mouse and type, in a control session" },
  { key: "screen", label: "Screenshots", help: "needed to look at the screen" },
  { key: "shell", label: "Commands and terminals", help: "PowerShell, and terminals such as Claude Code" },
  { key: "process", label: "Programs", help: "list and end programs" },
  { key: "registry", label: "Registry", help: "read, and change with your approval" },
];

const ago = (t: number): string => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

/** What a PC is doing, in a line. */
export function statusLine(pc: PcView): string {
  if (!pc.online) return `offline, last seen ${ago(pc.lastSeen)}`;
  const s = pc.status;
  const lease = pc.lease ? (pc.lease.paused ? "control paused (you took over)" : "control session running") : "";
  const parts = [s?.state ?? "online", lease, s?.task ? `task: ${s.task}` : "", s?.last ? `last: ${s.last}` : "", s?.sessions ? `${s.sessions} terminal${s.sessions === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.join(" | ");
}

/** A list typed one item per line. The text stays as typed (spaces and all) while the list is passed up. */
function Lines({ label, help, value, onChange, rows = 2 }: { label: string; help: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  const [text, setText] = useState(value.join("\n"));
  return (
    <label className="settings-field">
      <span>{help}</span>
      <textarea
        aria-label={label}
        rows={rows}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value.split("\n").map((l) => l.trim()).filter(Boolean));
        }}
      />
    </label>
  );
}

function PermissionsForm({ value, onChange }: { value: PcPermissions; onChange: (p: PcPermissions) => void }) {
  return (
    <div className="pc-perms">
      {SWITCHES.map((s) => (
        <label key={s.key} className="settings-check">
          <input type="checkbox" checked={value[s.key]} onChange={(e) => onChange({ ...value, [s.key]: e.target.checked })} /> <b>{s.label}</b> <small>{s.help}</small>
        </label>
      ))}
      <label className="settings-check">
        Files{" "}
        <select aria-label="Files" value={value.files} onChange={(e) => onChange({ ...value, files: e.target.value as PcPermissions["files"] })}>
          <option value="off">off</option>
          <option value="read">read only</option>
          <option value="write">read and write</option>
        </select>
      </label>
      <Lines label="Folders" rows={3} help="Folders (one per line: files and terminals work only inside these)" value={value.folders} onChange={(folders) => onChange({ ...value, folders })} />
      <Lines label="Extra words that ask" help="Extra words that make Friend ask first (one per line; added to the fixed list of delete, uninstall, pay...)" value={value.askPatterns ?? []} onChange={(askPatterns) => onChange({ ...value, askPatterns })} />
      <Lines label="Extra windows never touched" help="Extra windows Friend never touches (one title word per line; password managers, consent prompts and banks are always off limits)" value={value.denyWindows ?? []} onChange={(denyWindows) => onChange({ ...value, denyWindows })} />
    </div>
  );
}

/**
 * The Windows PCs: the list with what each is doing, adding a PC (the install command to copy), what each may do, a control session,
 * and revoking. Everything that changes something asks for the PIN.
 */
export function WindowsPcsPanel({ api = httpPcsApi, pollMs = 4000, onBack }: { api?: PcsApi; pollMs?: number; onBack?: () => void }) {
  const [pcs, setPcs] = useState<PcView[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<PcPermissions>(NO_PC_PERMISSIONS);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [minutes, setMinutes] = useState(30);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const l = await api.list();
      if (alive.current) setPcs(l);
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

  const run = async (job: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await job();
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
    if (step.kind !== "pin") return;
    void run(async () => {
      if (step.what === "add") {
        const added = await api.add(step.name ?? "", step.permissions, pin);
        setStep({ kind: "added", added });
        setName("");
        setPerms(NO_PC_PERMISSIONS);
      } else if (step.what === "perms" && step.pc) {
        await api.setPermissions(step.pc.id, step.permissions, pin);
        setStep({ kind: "list" });
      } else if (step.what === "revoke" && step.pc) {
        await api.revoke(step.pc.id, pin);
        setStep({ kind: "list" });
      } else if (step.what === "remove" && step.pc) {
        await api.remove(step.pc.id, pin);
        setStep({ kind: "list" });
      } else if (step.what === "reissue" && step.pc) {
        const r = await api.reissue(step.pc.id, pin);
        setStep({ kind: "added", added: { pc: step.pc, ...r } });
      }
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
    const words = { add: `Add the PC "${step.name}"?`, perms: `Save what ${step.pc?.name} may do?`, revoke: `Revoke ${step.pc?.name}? It is signed out at once and must be added again.`, remove: `Remove ${step.pc?.name} for good?`, reissue: step.pc?.revoked ? `Add ${step.pc?.name} again? You get a new install command to run on that PC. It keeps its name and permissions.` : `Make a new install command for ${step.pc?.name}? The old one stops working.` }[step.what];
    return (
      <div className="pc-panel">
        <p className="auth-note">{words} Enter your PIN to confirm.</p>
        <PinPad pin={pin} onChange={setPin} onSubmit={() => !busy && pin.length >= 6 && confirm()} />
        {err}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={busy || pin.length < 6} onClick={confirm}>
            Confirm
          </button>
          <button type="button" style={touch} onClick={() => { setStep({ kind: "list" }); setPin(""); setError(null); }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (step.kind === "add") {
    return (
      <div className="pc-panel">
        <label className="settings-field">
          <span>Name of the PC</span>
          <input aria-label="Name of the PC" value={name} maxLength={60} placeholder="Office PC" onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="auth-note">What may Friend do on this PC? Everything is off until you switch it on. You can change it later. Anything that cannot be undone still asks you first.</p>
        <PermissionsForm value={perms} onChange={setPerms} />
        {err}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" disabled={!name.trim()} onClick={() => setStep({ kind: "pin", what: "add", name: name.trim(), permissions: perms })}>
            Continue
          </button>
          {back}
        </div>
      </div>
    );
  }

  if (step.kind === "added") {
    const a = step.added;
    return (
      <div className="pc-panel">
        <p className="auth-note">
          <b>{a.pc.name}</b> is added. On that PC, open PowerShell (press Start, type <b>powershell</b>) and paste this one line, or download the small file and double-click it:
        </p>
        {a.install ? (
          <>
            <pre className="pc-command" data-testid="pc-command">{a.install.command}</pre>
            <div className="approval-actions">
              <button
                type="button"
                style={touch}
                className="primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(a.install!.command).then(() => setCopied(true)).catch(() => {});
                }}
              >
                {copied ? "Copied" : "Copy the command"}
              </button>
              <a className="button" style={touch} href={a.install.cmdUrl} download="install-friend-pc-agent.cmd">
                Download the file instead
              </a>
            </div>
            <p className="auth-note">It installs the official Node.js (checked for its signature) and the Friend agent (checked for its checksum) into your own user folder, starts it at every logon, and opens a page in your browser to approve the PC. It does not need administrator rights. The link works once, for 24 hours.</p>
          </>
        ) : (
          <p role="alert" className="auth-error">This Friend has no PC agent built yet. Run <code>pnpm --filter @friend/pc-agent bundle</code> (or update Friend), then add the PC again.</p>
        )}
        <div className="approval-actions">{back}</div>
      </div>
    );
  }

  if (step.kind === "perms") {
    return (
      <div className="pc-panel">
        <p className="auth-note">What may Friend do on <b>{step.pc.name}</b>?</p>
        <PermissionsForm value={perms} onChange={setPerms} />
        {err}
        <div className="approval-actions">
          <button type="button" style={touch} className="primary" onClick={() => setStep({ kind: "pin", what: "perms", pc: step.pc, permissions: perms })}>
            Save
          </button>
          {back}
        </div>
      </div>
    );
  }

  return (
    <div className="pc-panel">
      {err}
      {pcs && pcs.length === 0 && <p className="auth-note">No PCs yet. Add one: the assistant can then use it like a person (see the screen, click, type, run commands, work in a terminal).</p>}
      <ul className="plugin-list">
        {(pcs ?? []).map((pc) => (
          <li key={pc.id} data-pc={pc.name}>
            <div className="plugin-info">
              <strong>{pc.name}</strong> <small className={pc.online ? "pc-on" : "pc-off"}>{pc.revoked ? "revoked" : pc.online ? "online" : "offline"}</small>
              <div className="auth-note">{pc.revoked ? "Signed out. Press Add again for a new install command, then run it on that PC." : statusLine(pc)}</div>
              <div className="auth-note">
                {[pc.os, pc.host].filter(Boolean).join(", ")}
                {pc.permissions.control ? "" : " | control is off"}
              </div>
            </div>
            <div className="plugin-actions">
              {!pc.revoked && pc.online && pc.permissions.control && !pc.lease && (
                <>
                  <select aria-label={`Minutes for ${pc.name}`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                    {[15, 30, 60, 120].map((m) => (
                      <option key={m} value={m}>
                        {m} min
                      </option>
                    ))}
                  </select>
                  <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => { await api.control(pc.id, "start", minutes); await refresh(); })}>
                    Start control
                  </button>
                </>
              )}
              {!pc.revoked && pc.lease && (
                <button type="button" style={touch} disabled={busy} onClick={() => void run(async () => { await api.control(pc.id, "stop"); await refresh(); })}>
                  Stop control
                </button>
              )}
              {!pc.revoked && (
                <button type="button" style={touch} disabled={busy} onClick={() => { setPerms(pc.permissions); setStep({ kind: "perms", pc }); }}>
                  Permissions
                </button>
              )}
              {!pc.revoked && !pc.online && !pc.os && (
                <button type="button" style={touch} disabled={busy} onClick={() => setStep({ kind: "pin", what: "reissue", pc, permissions: pc.permissions })}>
                  New install command
                </button>
              )}
              {!pc.revoked ? (
                <button type="button" style={touch} className="danger" disabled={busy} onClick={() => setStep({ kind: "pin", what: "revoke", pc, permissions: pc.permissions })}>
                  Revoke
                </button>
              ) : (
                <>
                  <button type="button" style={touch} className="primary" disabled={busy} onClick={() => setStep({ kind: "pin", what: "reissue", pc, permissions: pc.permissions })}>
                    Add again
                  </button>
                  <button type="button" style={touch} className="danger" disabled={busy} onClick={() => setStep({ kind: "pin", what: "remove", pc, permissions: pc.permissions })}>
                    Remove
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" onClick={() => { setStep({ kind: "add" }); setError(null); }}>
          Add a PC
        </button>
        {onBack && back}
      </div>
    </div>
  );
}
