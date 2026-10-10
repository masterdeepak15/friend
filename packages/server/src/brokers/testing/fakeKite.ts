import { createHash, randomBytes } from "node:crypto";

export interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

/**
 * A stand-in for Zerodha's Kite Connect API (api.kite.trade), shaped like the real responses (checked against Zerodha's
 * documentation). Tests hand `fetch` to the provider; nothing here touches a network or a real account.
 */
export class FakeKite {
  readonly apiKey = "KEY";
  readonly apiSecret = "SECRET";
  readonly accessToken = "ACCESS-1";
  /** Set to false to make Zerodha answer 403 TokenException, as it does after the daily expiry. */
  tokenValid = true;

  holdings: unknown[] = [
    { tradingsymbol: "INFY", exchange: "NSE", isin: "INE009A01021", product: "CNC", quantity: 10, t1_quantity: 2, average_price: 1500, last_price: 1600, close_price: 1590, pnl: 1200, day_change: 10, day_change_percentage: 0.63 },
    { tradingsymbol: "TCS", exchange: "NSE", isin: "INE467B01029", product: "CNC", quantity: 5, t1_quantity: 0, average_price: 3500, last_price: 3400, close_price: 3450, pnl: -500, day_change: -50, day_change_percentage: -1.45 },
  ];
  positions: { net: unknown[]; day: unknown[] } = {
    net: [
      { tradingsymbol: "RELIANCE", exchange: "NSE", product: "MIS", quantity: 10, average_price: 2900, last_price: 2910, close_price: 2895, pnl: 100, m2m: 100 },
      { tradingsymbol: "SBIN", exchange: "NSE", product: "MIS", quantity: -20, average_price: 800, last_price: 795, close_price: 801, pnl: 100, m2m: 100 },
    ],
    day: [],
  };
  margins: unknown = {
    equity: { enabled: true, net: 50000, available: { cash: 40000, opening_balance: 40000, live_balance: 50000 }, utilised: { debits: 12000, exposure: 0, span: 0 } },
    commodity: { enabled: false, net: 0, available: {}, utilised: {} },
  };
  orders: unknown[] = [
    { order_id: "2610100001", status: "COMPLETE", tradingsymbol: "INFY", exchange: "NSE", transaction_type: "BUY", quantity: 2, price: 1590, average_price: 1589.5, order_type: "LIMIT", product: "CNC", order_timestamp: "2026-10-10 09:20:11" },
  ];

  /** Every request the fake has seen, oldest first. */
  requests: SeenRequest[] = [];

  private issued = new Set<string>();
  private failures = new Map<string, { status: number; message: string }>();
  private throwOnNext = false;

  /** A request token like the one Zerodha puts in the redirect after a login. It is accepted once. */
  issueRequestToken(): string {
    const token = randomBytes(8).toString("hex");
    this.issued.add(token);
    return token;
  }

  /** The next request to `path` fails with this HTTP status. */
  failNext(path: string, status: number, message = "Something went wrong"): void {
    this.failures.set(path, { status, message });
  }

  /** The next request of any kind throws, like a network that is down. */
  throwNext(): void {
    this.throwOnNext = true;
  }

  fetch: typeof fetch = async (input, init) => {
    if (this.throwOnNext) {
      this.throwOnNext = false;
      throw new TypeError("fetch failed");
    }
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const form = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    this.requests.push({ method, path: url.pathname, headers, form });

    const failure = this.failures.get(url.pathname);
    if (failure) {
      this.failures.delete(url.pathname);
      return json(failure.status, { status: "error", message: failure.message, error_type: failure.status === 429 ? "NetworkException" : "GeneralException" });
    }

    if (url.pathname === "/session/token" && method === "POST") {
      const wanted = createHash("sha256").update(`${form.api_key}${form.request_token}${this.apiSecret}`).digest("hex");
      if (form.api_key !== this.apiKey || !form.request_token || !this.issued.has(form.request_token) || form.checksum !== wanted) {
        return json(403, { status: "error", message: "Token is invalid or has expired.", error_type: "TokenException" });
      }
      this.issued.delete(form.request_token);
      return json(200, { status: "success", data: { user_id: "AB1234", user_name: "Test Owner", access_token: this.accessToken, login_time: "2026-10-10 09:30:00" } });
    }

    if (headers["x-kite-version"] !== "3" || headers.authorization !== `token ${this.apiKey}:${this.accessToken}` || !this.tokenValid) {
      return json(403, { status: "error", message: "Incorrect `api_key` or `access_token`.", error_type: "TokenException" });
    }
    if (method !== "GET") return json(405, { status: "error", message: "This fake only reads.", error_type: "InputException" });
    switch (url.pathname) {
      case "/portfolio/holdings":
        return json(200, { status: "success", data: this.holdings });
      case "/portfolio/positions":
        return json(200, { status: "success", data: this.positions });
      case "/user/margins":
        return json(200, { status: "success", data: this.margins });
      case "/orders":
        return json(200, { status: "success", data: this.orders });
      default:
        return json(404, { status: "error", message: "Not found", error_type: "GeneralException" });
    }
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
