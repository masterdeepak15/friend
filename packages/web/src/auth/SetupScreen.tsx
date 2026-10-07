import { useState, type FormEvent } from "react";
import { touch } from "../overlay/touch";

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [assistantName, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, pin, assistantName }),
      });
      if (res.ok) return onDone();
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Setup failed");
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth glass" onSubmit={submit}>
      <h1>Welcome</h1>
      <p className="auth-note">Create your account. This only works on the PC that runs Friend.</p>
      <label htmlFor="su-pw">Password (8+ characters)</label>
      <input id="su-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} style={touch} />
      <label htmlFor="su-pin">PIN (6+ digits)</label>
      <input id="su-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} style={touch} />
      <label htmlFor="su-name">Assistant name</label>
      <input id="su-name" value={assistantName} onChange={(e) => setName(e.target.value)} style={touch} />
      {error && <p role="alert" className="auth-error">{error}</p>}
      <button type="submit" className="primary" style={touch} disabled={busy || !password || !pin || !assistantName}>
        Create account
      </button>
    </form>
  );
}
