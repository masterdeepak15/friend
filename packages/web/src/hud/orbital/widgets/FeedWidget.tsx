import type { ChatLine } from "../../../store";

const SHOWN = 8;

/** The last few lines of the conversation and what Friend is doing now, like a terminal. */
export function FeedWidget({ lines, activity, busy, limit = SHOWN }: { lines: ChatLine[]; activity: string | null; busy: boolean; limit?: number }) {
  const last = lines.slice(-limit);
  return (
    <div className="ob-feed" aria-live="polite">
      {last.length === 0 && !busy && <p className="ob-li ob-sub">Nothing yet</p>}
      {last.map((l, i) => (
        <p key={lines.length - last.length + i} className={`ob-li ${l.role === "user" ? "ob-user" : ""}`}>
          {l.role === "user" ? "▸ " : "◂ "}
          {l.text}
        </p>
      ))}
      {busy && <p className="ob-li ob-live">⚙ {activity ?? "Working…"}</p>}
    </div>
  );
}