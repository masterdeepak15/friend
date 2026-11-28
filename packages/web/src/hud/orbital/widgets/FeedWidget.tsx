import type { ChatLine } from "../../../store";
import { ActivityList } from "../../../people/ActivityList";
import { colourOf, initials, type Act, type Who } from "../../../people/people";
import type { TeamLine } from "../office";

const SHOWN = 8;
/** A line of the conversation, or a plain coloured line (the sample feed). */
export type FeedLine = ChatLine | { text: string; tone: "green" | "orange" | "plain"; who?: Who; body?: string };
const MAX_CHARS = 46;
const cut = (s: string, max = MAX_CHARS): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The worker feed of the mockup: a terminal with a cut corner and a light running round it. A real feed shows the last lines of the
 * conversation and slides up by a line when a new one arrives; a sample feed (`marquee`) loops upward, as in the mockup.
 */
export function FeedWidget({ lines, activity, busy, limit = SHOWN, marquee = false }: { lines: FeedLine[]; activity: string | null; busy: boolean; limit?: number; marquee?: boolean }) {
  const shown = Math.min(limit, SHOWN - (busy ? 1 : 0));
  const last = marquee ? lines : lines.slice(-shown);
  const frame = "M0 0H400L430 30V210H0Z";
  const line = (l: FeedLine, y: number, key: string) =>
    "who" in l && l.who ? (
      // a line of a worker: a mark in the worker's own colour (a hexagon for the Office, a rounded square for the crew), then the words
      <g key={key}>
        {l.who.kind === "office" ? <polygon points={`22,${y - 6} 27,${y - 12} 39,${y - 12} 44,${y - 6} 39,${y} 27,${y}`} fill={colourOf(l.who)} /> : <rect x="20" y={y - 12} width="26" height="13" rx="4" fill={colourOf(l.who)} />}
        <text x="33" y={y - 2} textAnchor="middle" fontSize="8" fontWeight="800" fill="#031018">
          {initials(l.who.name)}
        </text>
        <text className={`ob-sm ${l.tone === "orange" ? "ob-org" : ""}`.trim()} x="52" y={y} fill={l.tone === "green" ? colourOf(l.who, 70) : undefined}>
          {cut(l.body ?? l.text, 38)}
        </text>
      </g>
    ) : (
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
      <text className="ob-lab" x="16" y="18">TEAM FEED · LIVE</text>
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
/**
 * The whole feed for the opened instrument: the team (Office and crew) and the conversation, every message under the name of whoever
 * it belongs to, in the colour of that person, with a key of who is who and a light on those at work.
 */
export function FeedLog({ lines, activity, busy, workers = [], working = [] }: { lines: ChatLine[]; activity: string | null; busy: boolean; workers?: TeamLine[]; working?: string[] }) {
  const you: Who = { id: "you", name: "You", kind: "you" };
  const friend: Who = { id: "friend", name: "Friend", kind: "friend" };
  const team: Act[] = workers.flatMap((l) => (l.who ? [{ who: l.who, at: l.at ?? 0, kind: l.kind ?? "text", text: l.body ?? l.text }] : []));
  const talk: Act[] = lines.slice(-200).map((l) => ({ who: l.role === "user" ? you : friend, at: 0, kind: "text", text: l.text }));
  const items: Act[] = [...team, ...talk, ...(busy ? [{ who: friend, at: 0, kind: "tool", text: activity ?? "Working…" }] : [])];
  return <ActivityList items={items} live={[...working, ...(busy ? ["friend"] : [])]} />;
}
