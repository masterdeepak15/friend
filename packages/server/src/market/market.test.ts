import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { formatCandles, parseChart } from "./format";
import { replay, sessionsOf } from "./replay";
import { cleanSymbol, runMarketTool, type MarketDeps } from "./tools";

const fx = (name: string): unknown => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", `${name}.json`), "utf8"));

function deps(answers: Record<string, unknown>) {
  const asked: string[] = [];
  const d: MarketDeps = {
    getJson: vi.fn(async (url: string) => {
      asked.push(url);
      const key = Object.keys(answers).find((k) => url.includes(k));
      return key ? { ok: true as const, json: answers[key] } : { ok: false as const, error: "The site answered with an error (500)." };
    }),
    audit: vi.fn(),
  };
  return { d, asked };
}

describe("symbols", () => {
  it("accepts NSE names in any case, with or without .NS, and nothing that could change an address", () => {
    expect(cleanSymbol("reliance.ns")).toBe("RELIANCE");
    expect(cleanSymbol(" M&M ")).toBe("M&M");
    expect(cleanSymbol("BAJAJ-AUTO")).toBe("BAJAJ-AUTO");
    for (const bad of ["../x", "a b/c", "RELIANCE?x=1", "", "x".repeat(21), 5, null]) expect(cleanSymbol(bad)).toBeNull();
  });
});

describe("candles", () => {
  it("shows one session in India time with the price columns", async () => {
    const { d, asked } = deps({ "v8/finance/chart": fx("chart-5m") });
    const r = await runMarketTool("market.get", { kind: "candles", symbol: "reliance" }, d);
    expect(r.ok).toBe(true);
    expect(asked[0]).toBe("https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?interval=5m&range=1d");
    expect(r.text).toMatch(/untrusted/i);
    expect(r.text).toMatch(/times in India time \(IST\)/);
    expect(r.text).toMatch(/\d{4}-\d\d-\d\d 09:15 /);
    expect(r.text.split("\n").length).toBeGreaterThan(60);
  });

  it("maps index names to Yahoo's symbols, and quotes with the change", async () => {
    const { d, asked } = deps({ "v8/finance/chart": fx("chart-5m") });
    const r = await runMarketTool("market.get", { kind: "quote", symbol: "NIFTY" }, d);
    expect(asked[0]).toContain("%5ENSEI");
    expect(r.text).toMatch(/\d+\.\d\d INR/);
  });

  it("caps the rows and says how many older ones were left out", () => {
    const s = parseChart(fx("chart-5m"))!;
    const text = formatCandles(s, "5m", 10);
    expect(text.split("\n")).toHaveLength(1 + 10 + 1);
    expect(text).toMatch(/\d+ older candles left out/);
  });

  it("says plainly when nothing came back, and when the feed fails", async () => {
    expect((await runMarketTool("market.get", { kind: "candles", symbol: "RELIANCE" }, deps({ "v8/finance/chart": { chart: { result: null } } }).d)).text).toMatch(/No data came back/);
    expect(await runMarketTool("market.get", { kind: "candles", symbol: "RELIANCE" }, deps({}).d)).toEqual({ ok: false, text: "The site answered with an error (500)." });
  });
});

describe("NSE feeds", () => {
  it("lists announcements with their date, the company and the filing link", async () => {
    const r = await runMarketTool("market.get", { kind: "announcements", symbol: "RELIANCE" }, deps({ "corporate-announcements": fx("announcements") }).d);
    expect(r.text).toMatch(/\d\d-[A-Za-z]{3}-\d{4} .* \| RELIANCE \|/);
    expect(r.text).toMatch(/https:\/\/nsearchives\.nseindia\.com\//);
  });
  it("lists quarterly results, insider trades, bulk deals and the shareholding pattern", async () => {
    const all = deps({ "financial-results": fx("results"), "corporates-pit": fx("insider"), largedeal: fx("deals"), "share-holdings": fx("holdings") });
    expect((await runMarketTool("market.get", { kind: "results", symbol: "RELIANCE" }, all.d)).text).toMatch(/RELIANCE .* Quarter/);
    expect((await runMarketTool("market.get", { kind: "insider", symbol: "RELIANCE" }, all.d)).text).toMatch(/Reliance Industries Limited \| .* shares/);
    expect((await runMarketTool("market.get", { kind: "bulk" }, all.d)).text).toMatch(/Bulk and block deals as on .*\n(bulk|block) \|/);
    expect((await runMarketTool("market.get", { kind: "holdings", symbol: "RELIANCE" }, all.d)).text).toMatch(/promoters \d+(\.\d+)?%/);
  });
  it("filters bulk deals to one symbol", async () => {
    const r = await runMarketTool("market.get", { kind: "bulk", symbol: "ZZZZ" }, deps({ largedeal: fx("deals") }).d);
    expect(r.text).toMatch(/No bulk or block deals in ZZZZ/);
  });
});

describe("what is refused", () => {
  it("a bad kind, a missing symbol, a bad symbol, and a company feed for an index", async () => {
    const { d, asked } = deps({});
    expect((await runMarketTool("market.get", { kind: "nope" }, d)).ok).toBe(false);
    expect((await runMarketTool("market.get", { kind: "candles" }, d)).text).toMatch(/needs a symbol/);
    expect((await runMarketTool("market.get", { kind: "candles", symbol: "../etc" }, d)).text).toMatch(/not an NSE symbol/);
    expect((await runMarketTool("market.get", { kind: "results", symbol: "NIFTY" }, d)).text).toMatch(/not an index/);
    expect(asked).toEqual([]);
  });
  it("only ever builds addresses on the two feeds", async () => {
    const { d, asked } = deps({});
    for (const kind of ["candles", "quote", "announcements", "results", "insider", "bulk", "holdings"]) await runMarketTool("market.get", { kind, symbol: "TCS" }, d);
    for (const u of asked) expect(u).toMatch(/^https:\/\/(query1\.finance\.yahoo\.com\/v8\/finance\/chart\/|www\.nseindia\.com\/api\/)/);
  });
});

/** Closes for one day: a slow rise with a small wobble, 75 candles from the open. */
const day = (base: number, wobble: number, n = 75) => Array.from({ length: n }, (_, i) => base + i * 0.05 + Math.sin(i * wobble) * 0.4);

describe("replay", () => {
  const sessions = [...Array.from({ length: 12 }, (_, k) => day(100 + k, 0.3 + k * 0.01)), day(100, 0.3).slice(0, 30)];
  const base = { sessions, side: "buy" as const, stop: 99, target: 103, runs: 2000, seed: 5 };

  it("counts every run once, and gives the same answer for the same seed", () => {
    const a = replay(base);
    const b = replay(base);
    expect(a).toEqual(b);
    if ("error" in a) throw new Error(a.error);
    const p = a.simulatedPercent;
    expect(p.target + p.stop + p.open).toBeGreaterThan(99.7);
    expect(p.target + p.stop + p.open).toBeLessThan(100.3);
    expect(a.pastDaysUsed).toBe(12);
    expect(Object.values(a.realPastDays).reduce((x, y) => x + y, 0)).toBe(12);
  });

  it("a target that is far away is rarely reached, and a stop already past the price is hit at once", () => {
    const far = replay({ ...base, target: 140 });
    if ("error" in far) throw new Error(far.error);
    expect(far.simulatedPercent.target).toBe(0);
    const tight = replay({ ...base, stop: 120, target: 130 });
    if ("error" in tight) throw new Error(tight.error);
    expect(tight.simulatedPercent.stop).toBe(100);
  });

  it("a sell works the other way round", () => {
    const r = replay({ ...base, side: "sell", stop: 103, target: 99 });
    if ("error" in r) throw new Error(r.error);
    expect(r.simulatedPercent.target + r.simulatedPercent.stop + r.simulatedPercent.open).toBeGreaterThan(99.7);
  });

  it("asks for more candles when there are too few days", () => {
    expect(replay({ ...base, sessions: sessions.slice(-3) })).toEqual({ error: expect.stringMatching(/at least 5 earlier/) });
  });

  it("groups real candles by India date, oldest first", () => {
    const s = parseChart(fx("chart-5m"))!;
    const groups = sessionsOf(s);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.length).toBe(s.candles.length);
  });

  it("the tool refuses a stop on the wrong side and does not fetch", async () => {
    const { d, asked } = deps({});
    const r = await runMarketTool("market.replay", { symbol: "TCS", side: "buy", stop: 110, target: 100 }, d);
    expect(r.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});

/** A Yahoo-shaped answer with `days` sessions of 75 five-minute candles, the last one cut after `todayCandles`. */
function history(days: number, todayCandles: number, lastDay = Date.UTC(2026, 9, 21)) {
  const offset = 19800;
  const timestamp: number[] = [];
  const close: number[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const open = (lastDay - d * 86_400_000) / 1000 + 9 * 3600 + 15 * 60 - offset;
    const n = d === 0 ? todayCandles : 75;
    for (let i = 0; i < n; i++) {
      timestamp.push(open + i * 300);
      close.push(100 + i * 0.03 + Math.sin(i * (0.2 + d * 0.03)) * 0.5);
    }
  }
  return { chart: { result: [{ meta: { symbol: "TCS.NS", currency: "INR", gmtoffset: offset }, timestamp, indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1) }] } }] } };
}
const at = (day: number, hh: number, mm: number) => Date.UTC(2026, 9, day, hh, mm) - 19800 * 1000;

describe("market.replay in the tool", () => {
  const args = { symbol: "TCS", side: "buy", stop: 99, target: 103, runs: 500 };
  it("plays the rest of a session in progress", async () => {
    const { d } = deps({ "v8/finance/chart": history(10, 30) });
    const r = await runMarketTool("market.replay", args, { ...d, now: () => at(21, 11, 45) });
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Simulated: target first [\d.]+%, stop first [\d.]+%/);
    expect(r.text).toMatch(/9 real past days/);
  });
  it("says the market is closed when the latest session is not today (a weekend or holiday)", async () => {
    const { d } = deps({ "v8/finance/chart": history(10, 75) });
    const r = await runMarketTool("market.replay", args, { ...d, now: () => at(24, 17, 30) });
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/market is not open today .*2026-10-21/) });
  });
  it("says the session is over after the last candle", async () => {
    const { d } = deps({ "v8/finance/chart": history(10, 75) });
    const r = await runMarketTool("market.replay", args, { ...d, now: () => at(21, 16, 0) });
    expect(r).toMatchObject({ ok: false, text: expect.stringMatching(/session is over/) });
  });
});

describe("lists come newest first", () => {
  it("sorts results and insider trades by their date, whatever order the NSE sent", async () => {
    const results = [{ symbol: "X", relatingTo: "Old", filingDate: "16-Jan-2025 20:20" }, { symbol: "X", relatingTo: "New", filingDate: "20-Oct-2026 09:00" }, { symbol: "X", relatingTo: "Mid", filingDate: "01-Aug-2025 10:00" }];
    const r = await runMarketTool("market.get", { kind: "results", symbol: "X" }, deps({ "financial-results": results }).d);
    expect(r.text.indexOf("New")).toBeLessThan(r.text.indexOf("Mid"));
    expect(r.text.indexOf("Mid")).toBeLessThan(r.text.indexOf("Old"));
    const insider = { data: [{ date: "18-Feb-2026 19:06", acqName: "A" }, { date: "02-Oct-2026 10:00", acqName: "B" }] };
    const i = await runMarketTool("market.get", { kind: "insider" }, deps({ "corporates-pit": insider }).d);
    expect(i.text.indexOf("B (")).toBeLessThan(i.text.indexOf("A ("));
  });
});
import { detectSetups, formatSetups } from "./scan";
import type { Series } from "./format";

/** One session of 5-minute candles from 09:15 IST: [open, high, low, close, volume] each. */
function session(bars: number[][], day = Date.UTC(2026, 9, 23)): Series {
  const open = day / 1000 + 9 * 3600 + 15 * 60 - 19800;
  return { symbol: "X.NS", currency: "INR", offset: 19800, last: null, previousClose: null, name: "X", candles: bars.map((b, i) => ({ t: open + i * 300, o: b[0]!, h: b[1]!, l: b[2]!, c: b[3]!, v: b[4]! })) };
}
const flat = (n: number, lo: number, hi: number, v = 100) => Array.from({ length: n }, () => [(lo + hi) / 2, hi, lo, (lo + hi) / 2, v]);

describe("setups", () => {
  it("finds an opening-range breakout: first close above the first 15 minutes' high, with levels worked out", () => {
    const s = session([...flat(3, 100, 102), [102, 103, 101.5, 101.8, 100], [101.8, 104, 101.8, 103.5, 300], [103.5, 104.5, 103.4, 104.2, 300]]);
    const [x] = detectSetups("X", s);
    expect(x).toMatchObject({ symbol: "X", kind: "orb-long", state: "triggered", at: "09:35", entry: 103.5, stop: 101, rangeLow: 100, rangeHigh: 102 });
    expect(x!.target).toBe(107.25); // 103.5 + 1.5 * 2.5
    expect(x!.volumeRatio).toBeGreaterThan(1);
  });

  it("finds a breakdown the other way, with the stop above the entry", () => {
    const s = session([...flat(3, 100, 102), [100, 100.5, 98.5, 99, 300], [99, 99.2, 97, 97.5, 300]]);
    const [x] = detectSetups("X", s);
    expect(x).toMatchObject({ kind: "orb-short", state: "triggered", entry: 99, stop: 101 });
    expect(x!.target).toBe(96);
  });

  it("drops a breakout whose price has come back inside the range, and calls one far past the trigger late", () => {
    expect(detectSetups("X", session([...flat(3, 100, 102), [102, 103, 101.5, 102.8, 100], [102.8, 102.9, 100.5, 101, 100]]))).toEqual([]);
    const late = detectSetups("X", session([...flat(3, 100, 102), [102, 103, 101.9, 102.6, 100], [102.6, 106, 102.5, 105.5, 100]]));
    expect(late[0]).toMatchObject({ state: "late" });
  });

  it("calls a stock near its range edge 'near', and an untouched middle nothing", () => {
    expect(detectSetups("X", session([...flat(3, 100, 102), [101.4, 101.8, 101.3, 101.7, 100]]))[0]).toMatchObject({ kind: "orb-long", state: "near", at: null, entry: 102 });
    expect(detectSetups("X", session([...flat(3, 100, 102), [101, 101.2, 100.8, 101, 100]]))).toEqual([]);
  });

  it("finds an oversold bounce: 2% under the open, a green last candle on above-average volume", () => {
    const s = session([[100, 100.5, 99, 99.5, 100], [99.5, 99.6, 97, 97.5, 100], [97.5, 97.6, 95.5, 96, 100], [96, 96.2, 95, 95.4, 100], [95.4, 96.8, 95.2, 96.5, 400]]);
    expect(detectSetups("X", s).find((x) => x.kind === "bounce")).toMatchObject({ entry: 96.5, stop: 95.2, state: "triggered" });
  });

  it("needs the first 15 minutes before it says anything", () => {
    expect(detectSetups("X", session(flat(3, 100, 102)))).toEqual([]);
  });

  it("ranks triggered setups above near ones and says how many stocks were looked at", () => {
    const a = detectSetups("A", session([...flat(3, 100, 102), [101.4, 101.8, 101.3, 101.7, 100]]));
    const b = detectSetups("B", session([...flat(3, 100, 102), [102, 103, 101.9, 102.6, 300], [102.6, 103.4, 102.5, 103.2, 300]]));
    const text = formatSetups([...a, ...b], 12, 5);
    expect(text).toMatch(/^Looked at 12 stocks\. 2 setups/);
    expect(text.indexOf("B |")).toBeLessThan(text.indexOf("A |"));
    expect(formatSetups([], 9, 5)).toMatch(/Looked at 9 stocks: none/);
  });
});

const chartOf = (s: Series) => ({ chart: { result: [{ meta: { symbol: s.symbol, currency: "INR", gmtoffset: 19800 }, timestamp: s.candles.map((k) => k.t), indicators: { quote: [{ open: s.candles.map((k) => k.o), high: s.candles.map((k) => k.h), low: s.candles.map((k) => k.l), close: s.candles.map((k) => k.c), volume: s.candles.map((k) => k.v) }] } }] } });

describe("market lists and the scan tool", () => {
  it("shows what is moving: gainers, losers, most active and volume spurts", async () => {
    const all = deps({ "variations?index=gainers": fx("gainers"), "variations?index=loosers": fx("losers"), "most-active": fx("active"), "volume-gainers": fx("volume") });
    expect((await runMarketTool("market.get", { kind: "movers" }, all.d)).text).toMatch(/Top gainers \(FOSec\)[\s\S]*\n[A-Z&-]+ \| \d/);
    expect((await runMarketTool("market.get", { kind: "movers", direction: "losers", universe: "NIFTY" }, all.d)).text).toMatch(/Top losers \(NIFTY\)/);
    expect(all.asked.some((u) => u.endsWith("index=loosers"))).toBe(true);
    expect((await runMarketTool("market.get", { kind: "active" }, all.d)).text).toMatch(/Most active by value[\s\S]*\n[A-Z&-]+ \| /);
    expect((await runMarketTool("market.get", { kind: "volume" }, all.d)).text).toMatch(/Volume spurts[\s\S]*\n[A-Z&-]+ \| .* \| x/);
  });

  it("scans your own symbols and ranks the setups it finds", async () => {
    const hit = session([...flat(3, 100, 102), [102, 103, 101.9, 102.6, 300], [102.6, 103.4, 102.5, 103.2, 300]]);
    const quiet = session([...flat(3, 100, 102), [101, 101.2, 100.8, 101, 100]]);
    const answers: Record<string, unknown> = { "TCS.NS": chartOf(hit), "INFY.NS": chartOf(quiet) };
    const d: MarketDeps = { getJson: vi.fn(async (url: string) => ({ ok: true as const, json: answers[Object.keys(answers).find((k) => url.includes(k))!] })), audit: vi.fn() };
    const r = await runMarketTool("market.scan", { symbols: ["tcs", "infy", "../bad"] }, d);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Looked at 2 stocks\. 1 setups/);
    expect(r.text).toMatch(/TCS \| LONG opening-range breakout at 09:30/);
    expect(r.text).not.toMatch(/INFY \|/);
  });

  it("with no symbols, scans what the market lists name, once each, and says so", async () => {
    const hit = chartOf(session([...flat(3, 100, 102), [102, 103, 101.9, 102.6, 300], [102.6, 103.4, 102.5, 103.2, 300]]));
    const asked: string[] = [];
    const d: MarketDeps = {
      getJson: vi.fn(async (url: string) => {
        asked.push(url);
        if (url.includes("v8/finance/chart")) return { ok: true as const, json: hit };
        const key = Object.entries({ "variations?index=gainers": "gainers", "variations?index=loosers": "losers", "most-active": "active", "volume-gainers": "volume" }).find(([k]) => url.includes(k));
        return key ? { ok: true as const, json: fx(key[1]) } : { ok: false as const, error: "no" };
      }),
      audit: vi.fn(),
    };
    const r = await runMarketTool("market.scan", {}, d);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Looked at \d+ stocks/);
    expect(r.text).toMatch(/most active, the volume spurts and the biggest F&O movers/);
    const charts = asked.filter((u) => u.includes("v8/finance/chart"));
    expect(new Set(charts).size).toBe(charts.length);
    expect(charts.length).toBeLessThanOrEqual(28);
    for (const u of asked) expect(u).toMatch(/^https:\/\/(query1\.finance\.yahoo\.com\/v8\/finance\/chart\/|www\.nseindia\.com\/api\/)/);
  });

  it("says so when no list and no candle can be read", async () => {
    expect(await runMarketTool("market.scan", {}, deps({}).d)).toMatchObject({ ok: false, text: expect.stringMatching(/could not be read/) });
  });
});
