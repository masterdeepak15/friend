import { dayKey, type Series } from "./format";

export type Outcome = "target" | "stop" | "open";
export interface ReplayResult {
  simulatedPercent: Record<Outcome, number>;
  realPastDays: Record<Outcome, number>;
  pastDaysUsed: number;
  runs: number;
  seed: number;
}

/** A small seeded generator, so the same seed gives the same answer. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The closes of each trading day, oldest first, as lists from the open. The last day is today. */
export function sessionsOf(s: Series): number[][] {
  const days = new Map<string, number[]>();
  for (const k of s.candles) {
    const key = dayKey(k.t, s.offset);
    days.set(key, [...(days.get(key) ?? []), k.c]);
  }
  return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, closes]) => closes);
}

const first = (path: number[], side: "buy" | "sell", stop: number, target: number): Outcome => {
  for (const p of path) {
    if (side === "buy" ? p <= stop : p >= stop) return "stop"; // within one candle the stop is assumed to come first
    if (side === "buy" ? p >= target : p <= target) return "target";
  }
  return "open";
};

const share = (c: Record<Outcome, number>): Record<Outcome, number> => {
  const total = c.target + c.stop + c.open || 1;
  return { target: Math.round((1000 * c.target) / total) / 10, stop: Math.round((1000 * c.stop) / total) / 10, open: Math.round((1000 * c.open) / total) / 10 };
};

/**
 * Plays the rest of today's session many times. Each new 5-minute close is the last one times a move drawn from what this stock did at
 * that same time of day on a past day. Also runs the same stop and target over the real rest of every past day, from the same time.
 */
export function replay(o: { sessions: number[][]; side: "buy" | "sell"; stop: number; target: number; runs: number; seed: number }): ReplayResult | { error: string } {
  const today = o.sessions[o.sessions.length - 1] ?? [];
  const past = o.sessions.slice(0, -1);
  const at = today.length - 1;
  const days = past.filter((d) => d.length > today.length);
  if (today.length < 2 || days.length < 5) return { error: "Not enough candles: need today so far and at least 5 earlier full days of 5-minute candles." };
  const longest = Math.max(...days.map((d) => d.length));
  const moves: number[][] = [];
  for (let i = at; i < longest - 1; i++) moves.push(days.filter((d) => d.length > i + 1).map((d) => d[i + 1]! / d[i]!));

  const rand = mulberry32(o.seed);
  const sim: Record<Outcome, number> = { target: 0, stop: 0, open: 0 };
  for (let r = 0; r < o.runs; r++) {
    let p = today[at]!;
    const path: number[] = [];
    for (const slot of moves) {
      p *= slot[Math.floor(rand() * slot.length)]!;
      path.push(p);
    }
    sim[first(path, o.side, o.stop, o.target)]++;
  }
  const real: Record<Outcome, number> = { target: 0, stop: 0, open: 0 };
  for (const d of days) {
    const scale = today[at]! / d[at]!;
    real[first(d.slice(today.length).map((x) => x * scale), o.side, o.stop, o.target)]++;
  }
  return { simulatedPercent: share(sim), realPastDays: real, pastDaysUsed: days.length, runs: o.runs, seed: o.seed };
}
