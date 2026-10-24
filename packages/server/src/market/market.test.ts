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