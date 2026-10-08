import { useEffect, useState } from "react";

/** Small date and time in the bottom-right corner, so the screen is never just an empty agent view. */
export function Clock({ now = () => new Date() }: { now?: () => Date }) {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), 5000);
    return () => clearInterval(id);
  }, [now]);
  return (
    <div className="clock" data-testid="clock" aria-label="Date and time">
      <time dateTime={t.toISOString()}>
        <b>{t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>
        <span>{t.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</span>
      </time>
    </div>
  );
}
