import { useState, type FormEvent } from "react";
import { touch } from "../overlay/touch";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        setPassword("");
        return onLoggedIn();
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Could not sign in");
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="auth glass" onSubmit={submit}>
      <h1>Friend</h1>
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} style={touch} />
      {error && <p role="alert" className="auth-error">{error}</p>}
      <button type="submit" className="primary" style={touch} disabled={busy || !password}>
        Sign in
      </button>
    </form>
  );
}
