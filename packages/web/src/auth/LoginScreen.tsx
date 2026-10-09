import { useEffect, useState, type FormEvent } from "react";
import { touch } from "../overlay/touch";

/** "0:45", "12:05": how long until sign-in is possible again. */
export const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

interface Refusal {
  error?: string;
  triesLeft?: number;
  retryAfterSeconds?: number;
}

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** When sign-in is allowed again, if the server has locked this address (a time on this browser's clock). */
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const left = Math.max(0, Math.ceil((lockedUntil - now) / 1000));
  const locked = left > 0;

  // count the lock down once a second, and clear the message when it is over
  useEffect(() => {
    if (!lockedUntil) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) {
        setLockedUntil(0);
        setError("");
      }
    }, 500);
    return () => clearInterval(id);
  }, [lockedUntil]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (locked) return;
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
      const body = (await res.json().catch(() => ({}))) as Refusal;
      setPassword("");
      if (body.retryAfterSeconds && body.retryAfterSeconds > 0) {
        const t = Date.now();
        setNow(t);
        setLockedUntil(t + body.retryAfterSeconds * 1000);
        setError(res.status === 429 ? "Too many wrong passwords." : "Wrong password.");
      } else if (res.status === 401 && typeof body.triesLeft === "number") {
        setError(`Wrong password. ${body.triesLeft} ${body.triesLeft === 1 ? "try" : "tries"} left before a lock.`);
      } else {
        setError(body.error ?? "Could not sign in");
      }
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
      <input id="pw" type="password" autoComplete="current-password" autoFocus value={password} disabled={locked} onChange={(e) => setPassword(e.target.value)} style={touch} />
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      {locked && (
        <p role="status" className="auth-note" data-testid="lock-countdown">
          Sign-in is locked for a short time to stop guessing. Try again in {clock(left)}.
        </p>
      )}
      <button type="submit" className="primary" style={touch} disabled={busy || locked || !password}>
        {locked ? `Locked ${clock(left)}` : "Sign in"}
      </button>
    </form>
  );
}
