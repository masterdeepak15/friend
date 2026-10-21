import { useEffect, useRef } from "react";
import type { ChatLine } from "../../../store";

const SHOWN = 8;
/** A line of the conversation, or a plain coloured line (the sample feed). */
export type FeedLine = ChatLine | { text: string; tone: "green" | "orange" | "plain" };
const MAX_CHARS = 46;
const cut = (s: string): string => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);

/**
 * The worker feed of the mockup: a terminal with a cut corner and a light running round it. A real feed shows the last lines of the
 * conversation and slides up by a line when a new one arrives; a sample feed (`marquee`) loops upward, as in the mockup.
 */
export function FeedWidget({ lines, activity, busy, limit = SHOWN, marquee = false }: { lines: FeedLine[]; activity: string | null; busy: boolean; limit?: number; marquee?: boolean }) {
  const shown = Math.min(limit, SHOWN - (busy ? 1 : 0));
  const last = marquee ? lines : lines.slice(-shown);
  const frame = "M0 0H400L430 30V210H0Z";
  const line = (l: FeedLine, y: number, key: string) => (
    <text key={key} className={"tone" in l ? `ob-sm ${l.tone === "green" ? "ob-grn" : l.tone === "orange" ? "ob-org" : ""}`.trim() : l.role === "user" ? "ob-sm" : "ob-sm ob-grn"} x="22" y={y}>
      {"tone" in l ? "" : l.role === "user" ? "▸ " : "◂ "}
      {cut(l.text)}
    </text>
  );
  return (
    <svg className="ob-wsvg ob-feed-svg" viewBox="0 0 430 210" aria-live="polite">
      <defs>
        <clipPath id="ob-feed-clip">
          <rect x="0" y="38" width="430" height="168" />
        </clipPath>
      </defs>
      <path className="ob-feed-frame" d={frame} />
      <path className="ob-feed-run" d={frame} pathLength={100} />
      <text className="ob-lab" x="16" y="18">WORKER FEED · LIVE</text>
      <circle className="ob-pulse" cx="410" cy="14" r="4" fill="#34d399" />
      {last.length === 0 && !busy && <text className="ob-dim" x="22" y="60">Nothing yet</text>}
      <g clipPath="url(#ob-feed-clip)">
        {marquee ? (
          <g className="ob-feed-scroll" style={{ ["--n" as string]: last.length * 20 }}>
            {[0, 1].flatMap((copy) => last.map((l, i) => line(l, 56 + (copy * last.length + i) * 20, `${copy}-${i}`)))}
          </g>
        ) : (
          <g key={`${lines.length}:${last.at(-1)?.text ?? ""}`} className="ob-feed-in">
            {last.map((l, i) => line(l, 56 + i * 20, String(i)))}
            {busy && (
              <text className="ob-sm ob-org" x="22" y={56 + last.length * 20}>
                ⚙ {cut(activity ?? "Working…")}
              </text>
            )}
          </g>
        )}
      </g>
      <rect className="ob-feed-fade" x="1" y="38" width="428" height="168" fill="url(#ob-fade)" pointerEvents="none" />
    </svg>
  );
}
/** The whole conversation as a scrolling list, for the opened instrument. */
export function FeedLog({ lines, activity, busy, workers = [] }: { lines: ChatLine[]; activity: string | null; busy: boolean; workers?: { text: string; tone: "green" | "orange" | "plain" }[] }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight; // opens at the newest line
  }, [lines.length, workers.length]);
  return (
    <div className="ob-feed" aria-live="polite" ref={box}>
      {lines.length === 0 && workers.length === 0 && !busy && <p className="ob-li ob-sub">Nothing yet</p>}
      {workers.map((l, i) => (
        <p key={`w${i}`} className={`ob-li${l.tone === "green" ? " ob-live" : l.tone === "orange" ? " ob-warn" : ""}`}>
          {l.text}
        </p>
      ))}
      {lines.slice(-200).map((l, i) => (
        <p key={i} className={`ob-li ${l.role === "user" ? "ob-user" : ""}`}>
          {l.role === "user" ? "▸ " : "◂ "}
          {l.text}
        </p>
      ))}
      {busy && <p className="ob-li ob-live">⚙ {activity ?? "Working…"}</p>}
    </div>
  );
}