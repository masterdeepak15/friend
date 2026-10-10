import { useState } from "react";
import { touch } from "../overlay/touch";

export interface SecretChange {
  current: string;
  newPassword?: string;
  newPin?: string;
}
export interface SecretResult {
  signedOutOthers: boolean;
}
export type ChangeSecrets = (change: SecretChange) => Promise<SecretResult>;

/** Sends the change to Friend. Rejects with a sentence the owner can read (wrong password, locked, too short). */
export const httpChangeSecrets: ChangeSecrets = async (change) => {
  let res: Response;
  try {
    res = await fetch("/api/account/secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
  } catch {
    throw new Error("Could not reach Friend. Check the connection.");
  }
  let body: { error?: string; triesLeft?: number; signedOutOthers?: boolean } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* no JSON body */
  }
  if (!res.ok) {
    const tries = typeof body.triesLeft === "number" && body.triesLeft > 0 ? ` ${body.triesLeft} ${body.triesLeft === 1 ? "try" : "tries"} left.` : "";
    throw new Error((body.error ?? (res.status === 401 ? "Please sign in again." : `The request failed (${res.status}).`)) + tries);
  }
  return { signedOutOthers: !!body.signedOutOthers };
};

/** Change the password or the PIN. The current password is always needed. */
export function SecurityTab({ change = httpChangeSecrets }: { change?: ChangeSecrets }) {
  const [current, setCurrent] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [repeatPin, setRepeatPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const wantsPassword = newPassword !== "" || repeatPassword !== "";
  const wantsPin = newPin !== "" || repeatPin !== "";

  const submit = async () => {
    setError(null);
    setDone(null);
    if (!current) return setError("Type your current password.");
    if (!wantsPassword && !wantsPin) return setError("Type a new password or a new PIN.");
    if (wantsPassword && newPassword.length < 8) return setError("The new password must be at least 8 characters.");
    if (wantsPassword && newPassword !== repeatPassword) return setError("The two new passwords are not the same.");
    if (wantsPin && !/^\d{6,}$/.test(newPin)) return setError("The new PIN must be at least 6 digits.");
    if (wantsPin && newPin !== repeatPin) return setError("The two new PINs are not the same.");
    setBusy(true);
    try {
      const out = await change({ current, ...(wantsPassword ? { newPassword } : {}), ...(wantsPin ? { newPin } : {}) });
      setDone(
        [wantsPassword && "Password changed.", wantsPin && "PIN changed.", wantsPassword && out.signedOutOthers && "Other browsers and phones were signed out."].filter(Boolean).join(" "),
      );
      setCurrent("");
      setNewPassword("");
      setRepeatPassword("");
      setNewPin("");
      setRepeatPin("");
    } catch (e) {
      setError((e as Error).message);
      setCurrent("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="settings-section"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>Password and PIN</h3>
      <p className="auth-note">Change either one or both. Your current password is always needed. Forgot it? On this PC run: friend password</p>
      <label className="settings-field">
        <span>Current password</span>
        <input type="password" autoComplete="current-password" value={current} disabled={busy} onChange={(e) => setCurrent(e.target.value)} style={touch} />
      </label>
      <label className="settings-field">
        <span>New password</span>
        <input type="password" autoComplete="new-password" value={newPassword} disabled={busy} onChange={(e) => setNewPassword(e.target.value)} style={touch} />
      </label>
      <label className="settings-field">
        <span>New password again</span>
        <input type="password" autoComplete="new-password" value={repeatPassword} disabled={busy} onChange={(e) => setRepeatPassword(e.target.value)} style={touch} />
      </label>
      <label className="settings-field">
        <span>New PIN</span>
        <input type="password" inputMode="numeric" autoComplete="off" value={newPin} disabled={busy} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))} style={touch} />
      </label>
      <small className="auth-note">The PIN is at least 6 digits. It is asked before risky actions.</small>
      <label className="settings-field">
        <span>New PIN again</span>
        <input type="password" inputMode="numeric" autoComplete="off" value={repeatPin} disabled={busy} onChange={(e) => setRepeatPin(e.target.value.replace(/\D/g, ""))} style={touch} />
      </label>
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      {done && <p role="status" className="auth-note">{done}</p>}
      <button type="submit" className="primary" style={touch} disabled={busy}>
        {busy ? "Saving…" : "Change"}
      </button>
    </form>
  );
}
