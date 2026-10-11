import { BrokerError, type BrokerProvider, type Funds, type Holding, type Order, type Position } from "./types";

/** One part of the account: what it holds, or why it could not be read (the rest of the account is still shown). */
export type Section<T> = { ok: true; data: T } | { ok: false; error: string; kind: BrokerError["kind"] };

export interface PortfolioSnapshot {
  /** When it was read (epoch milliseconds). */
  at: number;
  holdings: Section<Holding[]>;
  positions: Section<Position[]>;
  funds: Section<Funds>;
  orders: Section<Order[]>;
}

export interface PortfolioSummary {
  value: number;
  invested: number;
  pnl: number;
  pnlPct: number;
  dayChange: number;
  dayChangePct: number;
  /** Up to three holdings that are up the most today, biggest first. Only those that are up. */
  gainers: Holding[];
  /** Up to three that are down the most today, biggest drop first. Only those that are down. */
  losers: Holding[];
  topHoldingPct: number;
  top: { symbol: string; pct: number }[];
}

const MOVERS = 3;
const TOP = 5;
const r2 = (n: number): number => (Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0);

/** The numbers of a portfolio, worked out from its holdings. Pure; an empty account gives zeros, never NaN. */
export function summarize(holdings: Holding[]): PortfolioSummary {
  let value = 0;
  let invested = 0;
  let yesterday = 0;
  for (const h of holdings) {
    value += h.quantity * h.lastPrice;
    invested += h.quantity * h.avgPrice;
    yesterday += h.quantity * h.closePrice;
  }
  const dayChange = value - yesterday;
  const pnl = value - invested;
  const move = (h: Holding) => h.quantity * (h.lastPrice - h.closePrice);
  const worth = (h: Holding) => h.quantity * h.lastPrice;
  const top = [...holdings]
    .sort((a, b) => worth(b) - worth(a))
    .slice(0, TOP)
    .map((h) => ({ symbol: h.symbol, pct: value > 0 ? r2((worth(h) / value) * 100) : 0 }));
  return {
    value: r2(value),
    invested: r2(invested),
    pnl: r2(pnl),
    pnlPct: invested > 0 ? r2((pnl / invested) * 100) : 0,
    dayChange: r2(dayChange),
    dayChangePct: yesterday > 0 ? r2((dayChange / yesterday) * 100) : 0,
    gainers: holdings.filter((h) => move(h) > 0).sort((a, b) => move(b) - move(a)).slice(0, MOVERS),
    losers: holdings.filter((h) => move(h) < 0).sort((a, b) => move(a) - move(b)).slice(0, MOVERS),
    topHoldingPct: top[0]?.pct ?? 0,
    top,
  };
}

/** Reads the account through the broker, keeps it for a short time (so chat and reports never hit the broker's rate limit), and shares one read between callers. */
export class Portfolio {
  private cached: PortfolioSnapshot | null = null;
  private inflight: Promise<PortfolioSnapshot> | null = null;

  constructor(
    private provider: BrokerProvider,
    private clock: () => number = Date.now,
    /** How long a read is kept, in milliseconds; a function, so the owner's setting applies as soon as it changes. */
    private ttlMs: number | (() => number) = 30_000,
  ) {}

  invalidate(): void {
    this.cached = null;
  }

  snapshot(): Promise<PortfolioSnapshot> {
    if (this.cached && this.clock() - this.cached.at < (typeof this.ttlMs === "function" ? this.ttlMs() : this.ttlMs)) return Promise.resolve(this.cached);
    this.inflight ??= this.read().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async read(): Promise<PortfolioSnapshot> {
    const at = this.clock();
    const caps = this.provider.capabilities;
    const [holdings, positions, funds, orders] = await Promise.all([
      section(caps.holdings, () => this.provider.holdings()),
      section(caps.positions, () => this.provider.positions()),
      section(caps.funds, () => this.provider.funds()),
      section(caps.orders, () => this.provider.orders()),
    ]);
    this.cached = { at, holdings, positions, funds, orders };
    return this.cached;
  }
}

async function section<T>(supported: boolean, read: () => Promise<T>): Promise<Section<T>> {
  if (!supported) return { ok: false, error: "Not available from this broker.", kind: "other" };
  try {
    return { ok: true, data: await read() };
  } catch (e) {
    // a broker's own message is safe to show; anything else could carry paths or secrets
    return e instanceof BrokerError ? { ok: false, error: e.message, kind: e.kind } : { ok: false, error: "Could not read this.", kind: "other" };
  }
}
