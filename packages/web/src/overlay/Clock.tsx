import type { HudView } from "@friend/protocol";
import { useEffect, useState } from "react";
import { Movable } from "../layout/Movable";

type ClockSettings = HudView["clock"];
const DEFAULT: ClockSettings = { hour12: true, seconds: false, locale: "" };

/** A run of digits where each one rolls up into place when it changes. */
const Digits = ({ text }: { text: string }) => (
  <>
    {[...text].map((c, i) => (
      <span key={`${i}-${c}`} className="hud-digit">
        {c}
      </span>
    ))}
  </>
);

/**
 * The date and time widget: the day of the month big, with the month on a bar under it and the weekday beside it, and the time
 * with a thin line and a small circle. The colon blinks and a dot travels along the line once a second.
 */
export function Clock({ now = () => new Date(), clock = DEFAULT }: { now?: () => Date; clock?: ClockSettings }) {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = setInterval(() => setT(now()), clock.seconds ? 1000 : 5000);
    return () => clearInterval(id);
  }, [now, clock.seconds]);
  const locale = clock.locale || undefined;
  const parts = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", ...(clock.seconds ? { second: "2-digit" } : {}), hour12: clock.hour12 }).formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hh = get("hour");
  const mm = get("minute");
  const ss = get("second");
  const period = get("dayPeriod");
  const month = t.toLocaleDateString(locale, { month: "long" });
  const weekday = t.toLocaleDateString(locale, { weekday: "long" });
  return (
    <Movable id="clock" label="Clock" wholeBox testId="clock" className="hud hud-clock">
      <time dateTime={t.toISOString()}>
        <span className="hud-date">
          <b className="hud-day">
            <Digits text={String(t.getDate()).padStart(2, "0")} />
          </b>
          <span className="hud-month">{month}</span>
          <small className="hud-weekday">{weekday}</small>
        </span>
        <span className="hud-time-block">
          <span className="hud-clock-time">
            <Digits text={hh} />
            <i className="hud-colon">:</i>
            <Digits text={mm} />
            {clock.seconds && (
              <>
                <i className="hud-colon">:</i>
                <Digits text={ss} />
              </>
            )}
            {period && <small className="hud-period">{period}</small>}
          </span>
          <span className="hud-line">
            <i className="hud-dot" />
          </span>
        </span>
      </time>
    </Movable>
  );
}
