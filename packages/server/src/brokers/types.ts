/**
 * What the rest of Friend knows about a stock broker. A broker is one file that implements `BrokerProvider`; reports, tools,
 * the skill and the screens only ever see these shapes, so adding Angel One, Upstox or another broker touches none of them.
 * All money is plain rupees (numbers), times are ISO strings, symbols are the broker's trading symbol plus the exchange.
 */

export interface Holding {
  symbol: string;
  exchange: string;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  closePrice: number;
  pnl: number;
  dayChange: number;
  dayChangePct: number;
  product: string;
}

/** An open position. A negative quantity is a short. */
export interface Position {
  symbol: string;
  exchange: string;
  product: string;
  quantity: number;
  avgPrice: number;
  lastPrice: number;
  pnl: number;
}

export interface Funds {
  available: number;
  used: number;
  total: number;
}

export interface Order {
  id: string;
  symbol: string;
  exchange: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  avgPrice: number;
  type: string;
  product: string;
  status: string;
  at: string;
}

/** What a provider can do. Reports and the AI adapt to this: they leave out what is missing and say so. */
export interface Capabilities {
  holdings: boolean;
  positions: boolean;
  funds: boolean;
  orders: boolean;
  mutualFunds: boolean;
  /** Prices for symbols the owner does not hold (a paid data plan at most brokers). */
  quotes: boolean;
  /** Always false in this version: no provider can place orders, and no code reads this flag. */
  placeOrders: boolean;
}

export interface SessionInfo {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** How the owner logs in at that broker. */
export type LoginFlow =
  | {
      kind: "redirect";
      /** The broker's own login page; the owner's password and 2FA never reach Friend. `state` comes back in the redirect. */
      loginUrl(state: string): string;
      /** Finishes the login with what the broker's redirect carried. */
      complete(params: Record<string, string>): Promise<SessionInfo>;
    }
  | {
      kind: "credentials";
      fields: string[];
      complete(values: Record<string, string>): Promise<SessionInfo>;
    };

/** Why a broker call failed, so reports and the AI can say the right thing (and never retry in a loop). */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly kind: "session" | "rate" | "auth" | "network" | "other",
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrokerProvider {
  id: string;
  name: string;
  capabilities: Capabilities;
  login: LoginFlow;
  setSession(info: SessionInfo | null): void;
  sessionExpiresAt(): number | null;
  holdings(): Promise<Holding[]>;
  positions(): Promise<Position[]>;
  funds(): Promise<Funds>;
  orders(): Promise<Order[]>;
}
