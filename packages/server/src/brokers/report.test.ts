import { describe, expect, it } from "vitest";
import type { PortfolioSnapshot } from "./portfolio";
import { buildReport, formatInr } from "./report";
import type { Capabilities, Holding } from "./types";

const caps: Capabilities = { holdings: true, positions: true, funds: true, orders: true, mutualFunds: false, quotes: false, placeOrders: false };
const NOW = new Date(Date.UTC(2026, 9, 10, 4, 0, 0)); // 09:30 on Saturday 10 October 2026 in India

const h = (symbol: string, quantity: number, avg: number, last: number, close: number): Holding => ({
  symbol, exchange: "NSE", quantity, avgPrice: avg, lastPrice: last, closePrice: close, pnl: quantity * (last - avg), dayChange: last - close, dayChangePct: close ? ((last - close) / close) * 100 : 0, product: "CNC",
});

const rich = (): PortfolioSnapshot => ({
  at: NOW.getTime(),
  holdings: { ok: true, data: [h("INFY", 100, 1500, 1600, 1600), h("TCS", 10, 3500, 3000, 3300), h("WIPRO", 50, 350, 400, 380)] },
  positions: { ok: true, data: [
    { symbol: "RELIANCE", exchange: "NSE", product: "MIS", quantity: 10, avgPrice: 2900, lastPrice: 2910, pnl: 100 },
    { symbol: "SBIN", exchange: "NSE", product: "MIS", quantity: -20, avgPrice: 800, lastPrice: 795, pnl: 100 },
  ] },
  funds: { ok: true, data: { available: 50000, used: 12000, total: 62000 } },
  orders: { ok: true, data: [{ id: "1", symbol: "INFY", exchange: "NSE", side: "BUY", quantity: 2, price: 1590, avgPrice: 1589.5, type: "LIMIT", product: "CNC", status: "COMPLETE", at: "2026-10-10 09:20:11" }] },
});
const build = (snapshot: PortfolioSnapshot, over: Partial<Parameters<typeof buildReport>[0]> = {}) => buildReport({ snapshot, kind: "morning", caps, now: NOW, broker: "Zerodha", ...over });

describe("rupees in Indian grouping", () => {
  it("groups the last three digits, then pairs", () => {
    expect(formatInr(12345678.9)).toBe("₹1,23,45,678.90");
    expect(formatInr(100000)).toBe("₹1,00,000.00");
    expect(formatInr(1000)).toBe("₹1,000.00");
    expect(formatInr(999.5)).toBe("₹999.50");
    expect(formatInr(0)).toBe("₹0.00");
  });
  it("puts the minus before the rupee sign", () => {
    expect(formatInr(-1200.5)).toBe("-₹1,200.50");
    expect(formatInr(-0.004)).toBe("₹0.00"); // not "-₹0.00"
  });
  it("shows something sane for numbers that are not numbers", () => {
    expect(formatInr(Number.NaN)).toBe("₹0.00");
    expect(formatInr(Number.POSITIVE_INFINITY)).toBe("₹0.00");
  });
});

describe("the report", () => {
  it("has a title with the kind, the broker and the local time", () => {
    expect(build(rich()).split("\n")[0]).toBe("Morning report - Zerodha - Sat 10 Oct, 09:30");
    expect(build(rich(), { kind: "close" }).split("\n")[0]).toMatch(/^Market close report - Zerodha/);
    expect(build(rich(), { kind: "custom" }).split("\n")[0]).toMatch(/^Portfolio report - Zerodha/);
  });

  it("gives the value, profit and loss, and today's change with signs and percent", () => {
    const text = build(rich());
    expect(text).toContain("Portfolio: ₹2,10,000.00 (invested ₹2,02,500.00)");
    expect(text).toContain("Profit/loss: +₹7,500.00 (+3.70%)");
    expect(text).toContain("Today: -₹2,000.00 (-0.94%)");
  });

  it("lists the biggest movers of the day, up and down", () => {
    const text = build(rich());
    expect(text).toMatch(/Up today:\n- WIPRO \+₹1,000\.00/);
    expect(text).toMatch(/Down today:\n- TCS -₹3,000\.00/);
  });

  it("lists open positions, showing a short as negative", () => {
    const text = build(rich());
    expect(text).toContain("RELIANCE MIS 10 @ ₹2,900.00, P&L +₹100.00");
    expect(text).toContain("SBIN MIS -20 (short) @ ₹800.00, P&L +₹100.00");
  });

  it("gives funds and today's order count", () => {
    const text = build(rich());
    expect(text).toContain("Funds: ₹50,000.00 available, ₹12,000.00 used");
    expect(text).toContain("Orders today: 1");
  });

  it("flags concentration and big drops as facts, not advice", () => {
    const text = build(rich());
    expect(text).toMatch(/Worth a look:\n- INFY is 76\.2% of the portfolio/);
    expect(text).toMatch(/- TCS is down 9\.1% today/);
    expect(text).not.toMatch(/WIPRO is down/);
  });

  it("leaves out the flags when there is nothing to flag", () => {
    const snap = rich();
    snap.holdings = { ok: true, data: [h("A", 1, 100, 101, 100), h("B", 1, 100, 101, 100), h("C", 1, 100, 101, 100), h("D", 1, 100, 101, 100)] };
    expect(build(snap)).not.toContain("Worth a look");
  });

  it("says so for an empty account, without NaN", () => {
    const snap: PortfolioSnapshot = { at: 0, holdings: { ok: true, data: [] }, positions: { ok: true, data: [] }, funds: { ok: true, data: { available: 0, used: 0, total: 0 } }, orders: { ok: true, data: [] } };
    const text = build(snap);
    expect(text).toContain("No holdings.");
    expect(text).toContain("No open positions.");
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it("keeps going when one part could not be read, and says which and why", () => {
    const snap = rich();
    snap.positions = { ok: false, error: "Too many requests", kind: "rate" };
    snap.funds = { ok: false, error: "x", kind: "session" };
    const text = build(snap);
    expect(text).toContain("Positions: not available (rate limit)");
    expect(text).toContain("Funds: not available (login expired)");
    expect(text).toContain("Portfolio: ₹2,10,000.00"); // the part that worked is still there
  });

  it("when the holdings cannot be read it still reports the rest", () => {
    const snap = rich();
    snap.holdings = { ok: false, error: "down", kind: "network" };
    const text = build(snap);
    expect(text).toContain("Holdings: not available (network problem)");
    expect(text).toContain("Funds: ₹50,000.00");
    expect(text).not.toContain("Portfolio:");
  });

  it("leaves out parts the broker cannot give, and never mentions live prices when it has none", () => {
    const text = build(rich(), { caps: { ...caps, positions: false, orders: false } });
    expect(text).not.toMatch(/position/i);
    expect(text).not.toContain("Orders today");
    expect(text).not.toMatch(/quote|live price/i);
  });

  it("never reads like advice: no buy, sell, recommend, target or should", () => {
    const text = build(rich());
    expect(text).not.toMatch(/\b(buy|sell|recommend\w*|target|should)\b/i);
  });

  it("uses the owner's time zone for the title", () => {
    expect(build(rich(), { zone: "UTC" }).split("\n")[0]).toBe("Morning report - Zerodha - Sat 10 Oct, 04:00");
  });
});
