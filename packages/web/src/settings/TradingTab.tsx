const CHOICES: { id: string; label: string; note: string; locked: boolean }[] = [
  { id: "read", label: "Read only", note: "Friend can look at your portfolio, funds, positions and orders, and send you reports. It cannot place, change or cancel any order. This is the only level in this version.", locked: false },
  { id: "orders", label: "Orders with my confirmation (later version)", note: "Friend would prepare an order and wait for you to confirm it with your PIN.", locked: true },
  { id: "limits", label: "Orders within limits (later version)", note: "Friend would place small orders on its own, inside limits you set.", locked: true },
];

/** What Friend may do with money. Only "Read only" exists today; the other two are shown so the owner knows what is planned, and cannot be chosen. */
export function TradingTab({ level = "read" }: { level?: "read" }) {
  return (
    <div className="settings-section" role="radiogroup" aria-label="What Friend may do with money">
      <h3>What may Friend do with your trading account?</h3>
      {CHOICES.map((c) => (
        <label key={c.id} className="settings-check" style={{ alignItems: "flex-start", opacity: c.locked ? 0.55 : 1 }}>
          <input type="radio" name="trading" value={c.id} checked={!c.locked && level === c.id} disabled={c.locked} readOnly onChange={() => {}} />
          <span>
            <b>{c.label}</b>
            <br />
            <small className="auth-note">{c.note}</small>
          </span>
        </label>
      ))}
      <small className="auth-note">The assistant can never change this, even with your PIN. Orders will only arrive in a later version, with their own safeguards.</small>
    </div>
  );
}
