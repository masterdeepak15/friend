import { createHash } from "node:crypto";
import { BrokerError, type BrokerProvider, type Funds, type Holding, type Order, type Position, type SessionInfo } from "./types";

const API = "https://api.kite.trade";
const LOGIN = "https://kite.zerodha.com/connect/login";
/** Zerodha ends every access token at 06:00 India time the next morning. India has no daylight saving: 06:00 IST is 00:30 UTC. */
const SIX_IST_UTC_MS = 30 * 60_000;
const DAY_MS = 24 * 3600_000;

/** The next 06:00 IST strictly after `now` (epoch milliseconds). */
export function nextSixIst(now: number): number {
  const midnightUtc = now - (((now % DAY_MS) + DAY_MS) % DAY_MS);
  const today = midnightUtc + SIX_IST_UTC_MS;
  return today > now ? today : today + DAY_MS;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export interface ZerodhaOptions {
  apiKey: string;
  apiSecret: string;
  fetch?: typeof fetch;
  clock?: () => number;
}

/** Zerodha's Kite Connect API, read only. The free Personal plan covers everything used here (no quotes, no streaming). */
export function createZerodha(opts: ZerodhaOptions): BrokerProvider {
  const f = opts.fetch ?? fetch;
  const now = opts.clock ?? Date.now;
  let session: SessionInfo | null = null;

  /** Anything secret that an error message might echo back is blanked out. */
  const clean = (message: string): string => {
    let out = message;
    for (const secret of [session?.accessToken, opts.apiSecret, opts.apiKey]) if (secret) out = out.split(secret).join("***");
    return out.slice(0, 200);
  };

  const fail = (status: number, body: unknown): BrokerError => {
    const b = rec(body);
    const message = clean(str(b.message) || `Zerodha answered ${status}`);
    if (status === 403 || b.error_type === "TokenException") {
      session = null; // the token is no longer good: forget it
      return new BrokerError(message, "session");
    }
    if (status === 429) return new BrokerError(message, "rate");
    if (status === 502 || status === 503 || status === 504) return new BrokerError(message, "network");
    return new BrokerError(message, "other");
  };

  async function get(path: string): Promise<unknown> {
    if (!session || session.expiresAt <= now()) {
      session = null;
      throw new BrokerError("Not logged in to Zerodha.", "session");
    }
    let res: Response;
    try {
      res = await f(`${API}${path}`, { headers: { "X-Kite-Version": "3", Authorization: `token ${opts.apiKey}:${session.accessToken}` } });
    } catch {
      throw new BrokerError("Could not reach Zerodha.", "network");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw fail(res.status, body);
    return rec(body).data;
  }

  return {
    id: "zerodha",
    name: "Zerodha",
    capabilities: { holdings: true, positions: true, funds: true, orders: true, mutualFunds: false, quotes: false, placeOrders: false },
    login: {
      kind: "redirect",
      loginUrl: (state) => `${LOGIN}?v=3&api_key=${encodeURIComponent(opts.apiKey)}&redirect_params=${encodeURIComponent(`state=${state}`)}`,
      complete: async (params) => {
        const requestToken = params.request_token;
        if (!requestToken) throw new BrokerError("Zerodha did not send a login code.", "auth");
        const checksum = createHash("sha256").update(`${opts.apiKey}${requestToken}${opts.apiSecret}`).digest("hex");
        let res: Response;
        try {
          res = await f(`${API}/session/token`, {
            method: "POST",
            headers: { "X-Kite-Version": "3", "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ api_key: opts.apiKey, request_token: requestToken, checksum }),
          });
        } catch {
          throw new BrokerError("Could not reach Zerodha.", "network");
        }
        const body = rec(await res.json().catch(() => ({})));
        const token = str(rec(body.data).access_token);
        if (!res.ok || !token) throw new BrokerError(clean(str(body.message) || "Zerodha did not accept the login."), "auth");
        session = { accessToken: token, expiresAt: nextSixIst(now()) };
        return session;
      },
    },
    setSession: (info) => {
      session = info;
    },
    sessionExpiresAt: () => (session && session.expiresAt > now() ? session.expiresAt : null),

    async holdings(): Promise<Holding[]> {
      return rows(await get("/portfolio/holdings")).map((h) => ({
        symbol: str(h.tradingsymbol),
        exchange: str(h.exchange),
        // shares bought in the last day are held but not yet settled: they count as held
        quantity: num(h.quantity) + num(h.t1_quantity),
        avgPrice: num(h.average_price),
        lastPrice: num(h.last_price),
        closePrice: num(h.close_price),
        pnl: num(h.pnl),
        dayChange: num(h.day_change),
        dayChangePct: num(h.day_change_percentage),
        product: str(h.product),
      }));
    },
    async positions(): Promise<Position[]> {
      return rows(rec(await get("/portfolio/positions")).net).map((p) => ({
        symbol: str(p.tradingsymbol),
        exchange: str(p.exchange),
        product: str(p.product),
        quantity: num(p.quantity),
        avgPrice: num(p.average_price),
        lastPrice: num(p.last_price),
        pnl: num(p.pnl),
      }));
    },
    async funds(): Promise<Funds> {
      const equity = rec(rec(await get("/user/margins")).equity);
      const available = num(equity.net);
      const used = num(rec(equity.utilised).debits);
      return { available, used, total: available + used };
    },
    async orders(): Promise<Order[]> {
      return rows(await get("/orders")).map((o) => ({
        id: str(o.order_id),
        symbol: str(o.tradingsymbol),
        exchange: str(o.exchange),
        side: o.transaction_type === "SELL" ? "SELL" : "BUY",
        quantity: num(o.quantity),
        price: num(o.price),
        avgPrice: num(o.average_price),
        type: str(o.order_type),
        product: str(o.product),
        status: str(o.status),
        at: str(o.order_timestamp),
      }));
    },
  };
}
