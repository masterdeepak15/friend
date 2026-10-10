import { describe, expect, it } from "vitest";
import { Portfolio, summarize } from "./portfolio";
import { BrokerError, type BrokerProvider, type Holding } from "./types";

const h = (symbol: string, over: Partial<Holding> = {}): Holding => ({ symbol, exchange: "NSE", quantity: 10, avgPrice: 100, lastPrice: 110, closePrice: 108, pnl: 100, dayChange: 20, dayChangePct: 1.85, product: "CNC", ...over });

/** A provider that counts its calls and can be told to fail one section. */
function fake(opts: { holdings?: Holding[]; failPositions?: BrokerError } = {}) {
  const calls = { holdings: 0, positions: 0, funds: 0, orders: 0 };
  let release: (() => void) | null = null;
  let hold = false;
  const provider = {
    id: "fake",
    name: "Fake",
    capabilities: { holdings: true, positions: true, funds: true, orders: true, mutualFunds: false, quotes: false, placeOrders: false },
    login: { kind: "redirect", loginUrl: () => "", complete: async () => ({ accessToken: "", expiresAt: 0 }) },
    setSession: () => {},
    sessionExpiresAt: () => 1,
    holdings: async () => {
      calls.holdings++;
      if (hold) await new Promise<void>((r) => (release = r));
      return opts.holdings ?? [h("INFY")];
    },
    positions: async () => {
      calls.positions++;
      if (opts.failPositions) throw opts.failPositions;
      return [];
    },
    funds: async () => {
      calls.funds++;
      return { available: 1000, used: 0, total: 1000 };
    },
    orders: async () => {
      calls.orders++;
      return [];
    },
  } satisfies BrokerProvider;
  return { provider, calls, holdUntilReleased: () => (hold = true), release: () => release?.() };
}
const clockAt = (start: number) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe("the cache", () => {
  it("asks the broker once within 30 seconds and again after", async () => {
    const f = fake();
    const c = clockAt(0);
    const p = new Portfolio(f.provider, c.now);
    await p.snapshot();
    c.advance(29_000);
    await p.snapshot();
    expect(f.calls.holdings).toBe(1);
    c.advance(2_000);
    await p.snapshot();
    expect(f.calls.holdings).toBe(2);
  });

  it("is forgotten on request", async () => {
    const f = fake();
    const p = new Portfolio(f.provider, () => 0);
    await p.snapshot();
    p.invalidate();
    await p.snapshot();
    expect(f.calls.holdings).toBe(2);
  });

  it("shares one fetch between callers that ask at the same time", async () => {
    const f = fake();
    f.holdUntilReleased();
    const p = new Portfolio(f.provider, () => 0);
    const a = p.snapshot();
    const b = p.snapshot();
    await new Promise((r) => setTimeout(r, 5));
    f.release();
    expect((await a).at).toBe((await b).at);
    expect(f.calls.holdings).toBe(1);
  });
});

describe("a section that fails", () => {
  it("is reported as failed while the others stay", async () => {
    const f = fake({ failPositions: new BrokerError("Too many requests", "rate") });
    const snap = await new Portfolio(f.provider, () => 0).snapshot();
    expect(snap.positions).toEqual({ ok: false, error: "Too many requests", kind: "rate" });
    expect(snap.holdings.ok).toBe(true);
    expect(snap.funds).toEqual({ ok: true, data: { available: 1000, used: 0, total: 1000 } });
  });

  it("an error that is not a BrokerError is reported without its details", async () => {
    const f = fake();
    f.provider.orders = async () => {
      throw new Error("TypeError at /home/secret/file.ts");
    };
    const snap = await new Portfolio(f.provider, () => 0).snapshot();
    expect(snap.orders).toEqual({ ok: false, error: "Could not read this.", kind: "other" });
  });

  it("is not kept: the next snapshot after the cache time tries it again", async () => {
    const f = fake({ failPositions: new BrokerError("down", "network") });
    const c = clockAt(0);
    const p = new Portfolio(f.provider, c.now);
    await p.snapshot();
    c.advance(31_000);
    await p.snapshot();
    expect(f.calls.positions).toBe(2);
  });
});

describe("the summary", () => {
  it("is all zeros, not NaN, for an empty account", () => {
    expect(summarize([])).toEqual({ value: 0, invested: 0, pnl: 0, pnlPct: 0, dayChange: 0, dayChangePct: 0, gainers: [], losers: [], topHoldingPct: 0, top: [] });
  });

  it("has a percent of 0 when nothing was invested", () => {
    const s = summarize([h("FREE", { avgPrice: 0, quantity: 5, lastPrice: 10, pnl: 50, dayChange: 0 })]);
    expect(s.invested).toBe(0);
    expect(s.pnlPct).toBe(0);
    expect(Number.isFinite(s.dayChangePct)).toBe(true);
  });

  it("adds up value, invested, profit and day change from the holdings", () => {
    const s = summarize([h("A", { quantity: 10, avgPrice: 100, lastPrice: 110, closePrice: 108, pnl: 100, dayChange: 2 }), h("B", { quantity: 5, avgPrice: 200, lastPrice: 190, closePrice: 195, pnl: -50, dayChange: -5 })]);
    expect(s.value).toBe(2050); // 10*110 + 5*190
    expect(s.invested).toBe(2000); // 10*100 + 5*200
    expect(s.pnl).toBe(50);
    expect(s.pnlPct).toBe(2.5);
    expect(s.dayChange).toBe(-5); // (110-108)*10 + (190-195)*5 = 20 - 25
    expect(s.dayChangePct).toBeCloseTo(-0.24, 2); // -5 / (10*108 + 5*195)
  });

  it("ranks the biggest movers of the day, three each way, losers last", () => {
    const hs = ["A", "B", "C", "D", "E"].map((s, i) => h(s, { quantity: 1, lastPrice: 100 + (i - 2) * 10, closePrice: 100 }));
    const s = summarize(hs);
    expect(s.gainers.map((x) => x.symbol)).toEqual(["E", "D"]); // only those that are up
    expect(s.losers.map((x) => x.symbol)).toEqual(["A", "B"]);
  });

  it("shows how concentrated it is, and never more than 100 percent in total", () => {
    const s = summarize([h("BIG", { quantity: 90, lastPrice: 100 }), h("SMALL", { quantity: 10, lastPrice: 100 })]);
    expect(s.topHoldingPct).toBe(90);
    expect(s.top).toEqual([{ symbol: "BIG", pct: 90 }, { symbol: "SMALL", pct: 10 }]);
    expect(s.top.reduce((a, b) => a + b.pct, 0)).toBeLessThanOrEqual(100);
  });

  it("rounds to two decimals so that 0.1 + 0.2 is 0.3", () => {
    const s = summarize([h("A", { quantity: 1, avgPrice: 0.1, lastPrice: 0.1, closePrice: 0.1, pnl: 0.1, dayChange: 0 }), h("B", { quantity: 1, avgPrice: 0.2, lastPrice: 0.2, closePrice: 0.2, pnl: 0.2, dayChange: 0 })]);
    expect(s.value).toBe(0.3);
    expect(s.invested).toBe(0.3);
  });
});
