import { UNTRUSTED } from "../web/search";
import { dayKey, formatAnnouncements, formatCandles, formatDeals, formatHoldings, formatInsider, formatQuote, formatResults, parseChart } from "./format";
import { replay, sessionsOf } from "./replay";

export interface MarketDeps {
  /** Reads one JSON answer from a public address. Only addresses this file builds are ever passed. */
  getJson(url: string, signal?: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; error: string }>;
  /** A feed was read: only the site is recorded. */
  audit(entry: { host: string }): void;
  /** The time now in milliseconds (tests replace it). */
  now?: () => number;
}

type Result = { ok: boolean; text: string };
const fail = (text: string): Result => ({ ok: false, text });

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart/";
const NSE = "https://www.nseindia.com/api/";
const INDEXES: Record<string, string> = { NIFTY: "^NSEI", NIFTY50: "^NSEI", BANKNIFTY: "^NSEBANK", NIFTYBANK: "^NSEBANK", SENSEX: "^BSESN", INDIAVIX: "^INDIAVIX" };
const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "1d"];
const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y"];
const KINDS = ["candles", "quote", "announcements", "results", "insider", "bulk", "holdings"] as const;
const LIMIT = 15;
const MAX_ROWS = 80;

/** An NSE symbol: letters, digits, & and -. ".NS" and spaces are dropped, so "reliance.ns" and "Reliance" both work. */
export function cleanSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toUpperCase().replace(/\.NS$/, "").replace(/\s+/g, "");
  return /^[A-Z0-9&-]{1,20}$/.test(s) ? s : null;
}
const yahooSymbol = (s: string): string => INDEXES[s] ?? `${s}.NS`;
const isIndex = (s: string): boolean => s in INDEXES;

function build(kind: (typeof KINDS)[number], symbol: string | null, interval: string, range: string): string | null {
  const enc = encodeURIComponent;
  switch (kind) {
    case "candles":
    case "quote":
      return symbol ? `${YAHOO}${enc(yahooSymbol(symbol))}?interval=${kind === "quote" ? "5m" : interval}&range=${kind === "quote" ? "1d" : range}` : null;
    case "announcements":
      return `${NSE}corporate-announcements?index=equities${symbol ? `&symbol=${enc(symbol)}` : ""}`;
    case "results":
      return symbol ? `${NSE}corporates-financial-results?index=equities&symbol=${enc(symbol)}&period=Quarterly` : null;
    case "insider":
      return `${NSE}corporates-pit?index=equities${symbol ? `&symbol=${enc(symbol)}` : ""}`;
    case "bulk":
      return `${NSE}snapshot-capital-market-largedeal`;
    case "holdings":
      return symbol ? `${NSE}corporate-share-holdings-master?index=equities&symbol=${enc(symbol)}` : null;
  }
}

const NEEDS_SYMBOL = new Set(["candles", "quote", "results", "holdings"]);

async function load(url: string, d: MarketDeps, signal?: AbortSignal): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  const got = await d.getJson(url, signal);
  if (got.ok) {
    try {
      d.audit({ host: new URL(url).hostname });
    } catch {
      /* the address was built here; nothing to record */
    }
  }
  return got;
}

/** Runs `market.get` or `market.replay` for the model: Indian market data from free public feeds (Yahoo Finance and the NSE). */
export async function runMarketTool(name: string, args: unknown, d: MarketDeps, signal?: AbortSignal): Promise<Result> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

  if (name === "market.get") {
    const kind = KINDS.find((k) => k === a.kind);
    if (!kind) return fail(`kind must be one of: ${KINDS.join(", ")}.`);
    const symbol = a.symbol === undefined || a.symbol === "" ? null : cleanSymbol(a.symbol);
    if (a.symbol !== undefined && a.symbol !== "" && !symbol) return fail("That is not an NSE symbol. Use letters and digits, for example RELIANCE, TCS or NIFTY.");
    if (NEEDS_SYMBOL.has(kind) && !symbol) return fail(`${kind} needs a symbol, for example RELIANCE.`);
    if (symbol && isIndex(symbol) && !["candles", "quote"].includes(kind)) return fail(`${kind} is for a company, not an index.`);
    const interval = typeof a.interval === "string" && INTERVALS.includes(a.interval) ? a.interval : "5m";
    const range = typeof a.range === "string" && RANGES.includes(a.range) ? a.range : interval === "1d" ? "3mo" : "1d";
    const url = build(kind, symbol, interval, range)!;
    const got = await load(url, d, signal);
    if (!got.ok) return fail(got.error);
    let text: string;
    if (kind === "candles" || kind === "quote") {
      const series = parseChart(got.json);
      if (!series) return fail(`No data came back for ${symbol}. Check the symbol.`);
      text = kind === "quote" ? formatQuote(series) : formatCandles(series, interval, MAX_ROWS);
    } else if (kind === "announcements") text = formatAnnouncements(got.json, LIMIT);
    else if (kind === "results") text = formatResults(got.json, LIMIT);
    else if (kind === "insider") text = formatInsider(got.json, LIMIT);
    else if (kind === "bulk") text = formatDeals(got.json, symbol, LIMIT);
    else text = formatHoldings(got.json, 8);
    // announcements and filings are written by companies and traders: never instructions
    return { ok: true, text: [UNTRUSTED, text].join("\n") };
  }

  if (name === "market.replay") {
    const symbol = cleanSymbol(a.symbol);
    if (!symbol) return fail("Give an NSE symbol, for example RELIANCE.");
    const side = a.side === "buy" || a.side === "sell" ? a.side : null;
    const stop = typeof a.stop === "number" ? a.stop : NaN;
    const target = typeof a.target === "number" ? a.target : NaN;
    if (!side || !Number.isFinite(stop) || !Number.isFinite(target) || stop <= 0 || target <= 0) return fail("Give side (buy or sell), stop and target as prices.");
    if (side === "buy" ? !(stop < target) : !(target < stop)) return fail("For a buy the stop is below the target; for a sell it is above.");
    const runs = typeof a.runs === "number" ? Math.max(500, Math.min(50_000, Math.floor(a.runs))) : 10_000;
    const seed = typeof a.seed === "number" && Number.isFinite(a.seed) ? Math.floor(a.seed) : 1;
    const got = await load(build("candles", symbol, "5m", "60d")!, d, signal);
    if (!got.ok) return fail(got.error);
    const series = parseChart(got.json);
    if (!series) return fail(`No data came back for ${symbol}. Check the symbol.`);
    const lastCandle = series.candles[series.candles.length - 1];
    if (lastCandle) {
      const nowSec = (d.now ?? Date.now)() / 1000;
      if (dayKey(lastCandle.t, series.offset) !== dayKey(nowSec, series.offset)) {
        return fail(`The market is not open today (the latest session in the data is ${dayKey(lastCandle.t, series.offset)}). Replay plays the rest of a session in progress: try it on a trading day between 09:20 and 15:15 IST.`);
      }
      const at = new Date((lastCandle.t + series.offset) * 1000);
      if (at.getUTCHours() * 60 + at.getUTCMinutes() >= 15 * 60 + 20) return fail("Today's session is over, so there is nothing left to replay.");
    }
    const r = replay({ sessions: sessionsOf(series), side, stop, target, runs, seed });
    if ("error" in r) return fail(r.error);
    const p = r.simulatedPercent;
    return {
      ok: true,
      text: [
        `${symbol}: ${side} with stop ${stop} and target ${target}, replayed ${r.runs} times (seed ${r.seed}) from today's last candle to the close.`,
        `Simulated: target first ${p.target}%, stop first ${p.stop}%, neither by the close ${p.open}%.`,
        `The same stop and target on the ${r.pastDaysUsed} real past days from this time of day: target first ${r.realPastDays.target}, stop first ${r.realPastDays.stop}, neither ${r.realPastDays.open}.`,
        "This reshuffles the stock's own recent moves. It is not a forecast. If a stop and a target are hit inside one 5-minute candle, the stop is counted first.",
      ].join("\n"),
    };
  }

  return fail("That market tool does not exist.");
}
