/** Turns the answers of Yahoo Finance and the NSE into short lines of text the model can read. Nothing here fetches anything. */

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((r): r is Row => !!r && typeof r === "object") : []);
const str = (v: unknown, max = 200): string => {
  const s = typeof v === "string" || typeof v === "number" ? String(v) : "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/,/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const price = (n: number | null): string => (n === null ? "-" : n.toFixed(2));
const pad = (n: number): string => String(n).padStart(2, "0");

export interface Candle {
  /** Seconds since 1970. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface Series {
  symbol: string;
  currency: string;
  /** Seconds the exchange is ahead of UTC (19800 for India). */
  offset: number;
  candles: Candle[];
  last: number | null;
  previousClose: number | null;
  name: string;
}

/** The candles of a Yahoo chart answer, without the empty ones Yahoo leaves where nothing traded. */
export function parseChart(json: unknown): Series | null {
  const result = rows((json as { chart?: { result?: unknown } } | null)?.chart?.result)[0];
  if (!result) return null;
  const meta = (result.meta ?? {}) as Row;
  const quote = rows((result.indicators as { quote?: unknown } | undefined)?.quote)[0] ?? {};
  const ts = Array.isArray(result.timestamp) ? (result.timestamp as unknown[]) : [];
  const col = (k: string): unknown[] => (Array.isArray(quote[k]) ? (quote[k] as unknown[]) : []);
  const [o, h, l, c, v] = ["open", "high", "low", "close", "volume"].map(col);
  const candles: Candle[] = [];
  ts.forEach((t, i) => {
    const t1 = num(t);
    const cc = num(c![i]);
    if (t1 === null || cc === null) return;
    candles.push({ t: t1, o: num(o![i]) ?? cc, h: num(h![i]) ?? cc, l: num(l![i]) ?? cc, c: cc, v: num(v![i]) ?? 0 });
  });
  return {
    symbol: str(meta.symbol, 30),
    currency: str(meta.currency, 5),
    offset: num(meta.gmtoffset) ?? 0,
    candles,
    last: num(meta.regularMarketPrice),
    previousClose: num(meta.chartPreviousClose) ?? num(meta.previousClose),
    name: str(meta.longName ?? meta.shortName, 80),
  };
}

const local = (t: number, offset: number): Date => new Date((t + offset) * 1000);
export const dayKey = (t: number, offset: number): string => {
  const d = local(t, offset);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export function formatCandles(s: Series, interval: string, maxRows: number): string {
  if (s.candles.length === 0) return `No candles came back for ${s.symbol || "that symbol"}. The market may be closed, or the symbol is wrong.`;
  const daily = interval === "1d";
  const shown = s.candles.slice(-maxRows);
  const head = `${s.name || s.symbol} (${s.symbol}), ${interval} candles, times in India time (IST), prices in ${s.currency || "INR"}. Columns: ${daily ? "date" : "date time"} open high low close volume.`;
  const lines = shown.map((k) => {
    const d = local(k.t, s.offset);
    const when = daily ? dayKey(k.t, s.offset) : `${dayKey(k.t, s.offset)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    return `${when} ${price(k.o)} ${price(k.h)} ${price(k.l)} ${price(k.c)} ${k.v}`;
  });
  const last = s.candles[s.candles.length - 1]!;
  const age = local(last.t, s.offset);
  const tail = `Last candle starts ${dayKey(last.t, s.offset)} ${pad(age.getUTCHours())}:${pad(age.getUTCMinutes())} IST.${s.candles.length > shown.length ? ` (${s.candles.length - shown.length} older candles left out.)` : ""}`;
  return [head, ...lines, tail].join("\n");
}

export function formatQuote(s: Series): string {
  if (s.last === null) return `No price came back for ${s.symbol || "that symbol"}.`;
  const change = s.previousClose ? ((s.last - s.previousClose) / s.previousClose) * 100 : null;
  const highs = s.candles.map((k) => k.h);
  const lows = s.candles.map((k) => k.l);
  const parts = [`${s.name || s.symbol} (${s.symbol}): ${price(s.last)} ${s.currency || "INR"}`];
  if (change !== null) parts.push(`${change >= 0 ? "+" : ""}${change.toFixed(2)}% against the previous close ${price(s.previousClose)}`);
  if (highs.length) parts.push(`day range ${price(Math.min(...lows))} to ${price(Math.max(...highs))}`);
  return parts.join(", ");
}

/** NSE writes dates like 16-Jan-2025 20:20; its lists come in no fixed order, so sort by that date, newest first. */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const when = (s: unknown): number => {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?: (\d\d):(\d\d))?/.exec(typeof s === "string" ? s : "");
  return m ? Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]!.toLowerCase()), Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)) : 0;
};
const newestFirst = (list: Row[], key: string): Row[] => [...list].sort((a, b) => when(b[key]) - when(a[key]));

export function formatAnnouncements(json: unknown, limit: number): string {
  const list = rows(json).slice(0, limit);
  if (list.length === 0) return "No announcements were found.";
  return list
    .map((r) => `${str(r.an_dt, 24)} | ${str(r.symbol, 20)} | ${str(r.desc, 80)} | ${str(r.attchmntText, 240)}${r.attchmntFile ? ` | ${str(r.attchmntFile, 200)}` : ""}`)
    .join("\n");
}

export function formatResults(json: unknown, limit: number): string {
  const list = newestFirst(rows(json), "filingDate").slice(0, limit);
  if (list.length === 0) return "No results were found.";
  return list
    .map((r) => {
      const bits = [`${str(r.symbol, 20)} ${str(r.relatingTo, 30)} (${str(r.fromDate, 14)} to ${str(r.toDate, 14)})`, str(r.audited, 12), str(r.consolidated, 20), `filed ${str(r.filingDate, 20)}`];
      const link = str(r.resultDetailedDataLink ?? r.xbrl, 200);
      return bits.join(" | ") + (link ? ` | ${link}` : "");
    })
    .join("\n");
}

export function formatInsider(json: unknown, limit: number): string {
  const list = newestFirst(rows((json as { data?: unknown } | null)?.data), "date").slice(0, limit);
  if (list.length === 0) return "No insider trades were found.";
  return list
    .map((r) => {
      const sold = num(r.sellValue) ?? 0;
      const bought = num(r.buyValue) ?? 0;
      const side = str(r.tdpTransactionType, 12) || (bought > 0 ? "Buy" : sold > 0 ? "Sell" : "-");
      const value = Math.max(bought, sold) || num(r.secVal) || 0;
      return `${str(r.date, 20)} | ${str(r.company, 40)} | ${str(r.acqName, 40)} (${str(r.personCategory, 24)}) | ${side} | ${str(r.secAcq, 14)} shares | about Rs ${Math.round(value)} | ${str(r.acqMode, 20)} | holding after ${str(r.afterAcqSharesPer, 8)}%`;
    })
    .join("\n");
}

export function formatDeals(json: unknown, symbol: string | null, limit: number): string {
  const d = (json ?? {}) as Row;
  const pick = (key: string, label: string): string[] =>
    rows(d[key])
      .filter((r) => !symbol || str(r.symbol, 30).toUpperCase() === symbol)
      .slice(0, limit)
      .map((r) => `${label} | ${str(r.date, 12)} | ${str(r.symbol, 20)} | ${str(r.clientName, 60)} | ${str(r.buySell, 5)} | ${str(r.qty, 14)} shares at Rs ${str(r.watp, 12)}`);
  const lines = [...pick("BULK_DEALS_DATA", "bulk"), ...pick("BLOCK_DEALS_DATA", "block")].slice(0, limit);
  if (lines.length === 0) return symbol ? `No bulk or block deals in ${symbol} in the latest list (as on ${str(d.as_on_date, 12) || "-"}).` : "No bulk or block deals were found.";
  return [`Bulk and block deals as on ${str(d.as_on_date, 12)}. Columns: kind | date | symbol | client | buy or sell | quantity at average price.`, ...lines].join("\n");
}

export function formatHoldings(json: unknown, limit: number): string {
  const list = rows(json).slice(0, limit);
  if (list.length === 0) return "No shareholding pattern was found.";
  return list.map((r) => `${str(r.date, 14)} | ${str(r.name, 50)} | promoters ${str(r.pr_and_prgrp, 8)}% | public ${str(r.public_val, 8)}% | employee trusts ${str(r.employeeTrusts, 8)}`).join("\n");
}
