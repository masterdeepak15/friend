import { dayKey, type Candle, type Series } from "./format";

export type SetupKind = "orb-long" | "orb-short" | "bounce";
export type SetupState = "triggered" | "near" | "late";

export interface Setup {
  symbol: string;
  kind: SetupKind;
  state: SetupState;
  /** India time of the trigger candle, "10:15". */
  at: string | null;
  entry: number;
  stop: number;
  target: number;
  last: number;
  rangeLow: number;
  rangeHigh: number;
  /** The last three candles' volume against the session's average candle. */
  volumeRatio: number;
  score: number;
}

const OPENING_CANDLES = 3; // 09:15, 09:20 and 09:25: the first fifteen minutes
const REWARD = 1.5;
const BOUNCE_DROP = 0.02;
/** A trigger counts as "near" when the price is this close (share of the range) to the edge it has to close beyond. */
const NEAR = 0.25;
/** A move already this many range-widths past the trigger is chasing. */
const LATE = 1;

/** A trigger after this India time leaves little of the day to work with. */
const TOO_LATE_MINUTES = 14 * 60 + 30;
const minutes = (hhmmText: string): number => Number(hhmmText.slice(0, 2)) * 60 + Number(hhmmText.slice(3, 5));

const hhmm = (t: number, offset: number): string => {
  const d = new Date((t + offset) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};
const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The candles of the latest session in the data. */
export function latestSession(s: Series): Candle[] {
  const last = s.candles[s.candles.length - 1];
  if (!last) return [];
  const day = dayKey(last.t, s.offset);
  return s.candles.filter((k) => dayKey(k.t, s.offset) === day);
}

/**
 * The setups the day's candles show right now, by the same rules the day-trader skills describe: the opening-range breakout (first close
 * beyond the first fifteen minutes' high or low) and the oversold bounce (2% under the open, last candle green, volume above average).
 * Entry, stop and target are worked out the way `trade-plan` does: stop at the range's middle, target 1.5 times the risk.
 */
export function detectSetups(symbol: string, s: Series): Setup[] {
  const day = latestSession(s);
  if (day.length < OPENING_CANDLES + 1) return [];
  const range = day.slice(0, OPENING_CANDLES);
  const hi = Math.max(...range.map((k) => k.h));
  const lo = Math.min(...range.map((k) => k.l));
  const width = hi - lo;
  if (!(width > 0)) return [];
  const mid = (hi + lo) / 2;
  const after = day.slice(OPENING_CANDLES);
  const last = day[day.length - 1]!;
  const avgVol = day.reduce((a, k) => a + k.v, 0) / day.length || 1;
  const recent = day.slice(-3);
  const volumeRatio = r2(recent.reduce((a, k) => a + k.v, 0) / recent.length / avgVol);
  const out: Setup[] = [];

  const plan = (side: 1 | -1, entry: number, stop: number): { entry: number; stop: number; target: number } => ({ entry: r2(entry), stop: r2(stop), target: r2(entry + side * REWARD * Math.abs(entry - stop)) });

  const longTrigger = after.find((k) => k.c > hi);
  const shortTrigger = after.find((k) => k.c < lo);
  // the first break decides the side; a close back inside the range after it cancels the setup
  const first = [longTrigger, shortTrigger].filter((k): k is Candle => !!k).sort((a, b) => a.t - b.t)[0];
  if (first && first === longTrigger && last.c > hi) {
    const p = plan(1, first.c, mid);
    const late = (last.c - first.c) / width >= LATE;
    out.push({ symbol, kind: "orb-long", state: late ? "late" : "triggered", at: hhmm(first.t, s.offset), ...p, last: r2(last.c), rangeLow: r2(lo), rangeHigh: r2(hi), volumeRatio, score: 0 });
  } else if (first && first === shortTrigger && last.c < lo) {
    const p = plan(-1, first.c, mid);
    const late = (first.c - last.c) / width >= LATE;
    out.push({ symbol, kind: "orb-short", state: late ? "late" : "triggered", at: hhmm(first.t, s.offset), ...p, last: r2(last.c), rangeLow: r2(lo), rangeHigh: r2(hi), volumeRatio, score: 0 });
  } else if (!first) {
    if ((hi - last.c) / width <= NEAR && last.c <= hi) out.push({ symbol, kind: "orb-long", state: "near", at: null, ...plan(1, hi, mid), last: r2(last.c), rangeLow: r2(lo), rangeHigh: r2(hi), volumeRatio, score: 0 });
    else if ((last.c - lo) / width <= NEAR && last.c >= lo) out.push({ symbol, kind: "orb-short", state: "near", at: null, ...plan(-1, lo, mid), last: r2(last.c), rangeLow: r2(lo), rangeHigh: r2(hi), volumeRatio, score: 0 });
  }

  const open = day[0]!.o;
  if (last.c <= open * (1 - BOUNCE_DROP) && last.c > last.o && last.v > avgVol) {
    out.push({ symbol, kind: "bounce", state: "triggered", at: hhmm(last.t, s.offset), ...plan(1, last.c, last.l), last: r2(last.c), rangeLow: r2(lo), rangeHigh: r2(hi), volumeRatio, score: 0 });
  }

  for (const o of out) if (o.state === "triggered" && o.at && minutes(o.at) >= TOO_LATE_MINUTES) o.state = "late";
  for (const o of out) o.score = r2((o.state === "triggered" ? 3 : o.state === "near" ? 1.5 : 0.5) + Math.min(volumeRatio, 3) - (o.kind === "bounce" ? 0.5 : 0));
  return out;
}

export function formatSetups(list: Setup[], looked: number, limit: number): string {
  const ranked = [...list].sort((a, b) => b.score - a.score).slice(0, limit);
  if (ranked.length === 0) return `Looked at ${looked} stocks: none shows an opening-range breakout, a bounce or a setup close to triggering.`;
  const head = `Looked at ${looked} stocks. ${list.length} setups, best first. Levels: entry at the trigger close, stop at the middle of the opening range (bounce: under the bounce candle), target 1.5 times the risk. Volume = the last 15 minutes against the session's average candle.`;
  const lines = ranked.map((s) => {
    const side = s.kind === "orb-short" ? "SHORT" : "LONG";
    const what = s.kind === "bounce" ? "oversold bounce" : s.state === "near" ? "opening-range breakout, not triggered yet" : "opening-range breakout";
    const when = s.at ? ` at ${s.at}` : "";
    const risk = r2(Math.abs(s.entry - s.stop));
    const late = s.state === "late" ? " [LATE: already well past the trigger, chasing]" : "";
    return `${s.symbol} | ${side} ${what}${when} | range ${s.rangeLow}-${s.rangeHigh} | now ${s.last} | entry ${s.entry} stop ${s.stop} target ${s.target} (risk ${risk}/share) | volume x${s.volumeRatio}${late}`;
  });
  return [head, ...lines].join("\n");
}
