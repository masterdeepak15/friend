import { describe, expect, it } from "vitest";
import { BrokerError, type BrokerProvider, type Funds, type Holding, type Order, type Position } from "./types";

const finite = (what: string, ...values: number[]) => {
  for (const v of values) if (!Number.isFinite(v)) throw new Error(`${what}: every number must be finite (got ${v})`);
};
const named = (what: string, symbol: string) => {
  if (!symbol || !symbol.trim()) throw new Error(`${what}: the symbol is empty`);
};

export function checkHolding(h: Holding): void {
  named("holding", h.symbol);
  finite(`holding ${h.symbol}`, h.quantity, h.avgPrice, h.lastPrice, h.closePrice, h.pnl, h.dayChange, h.dayChangePct);
}
export function checkPosition(p: Position): void {
  named("position", p.symbol);
  finite(`position ${p.symbol}`, p.quantity, p.avgPrice, p.lastPrice, p.pnl);
}
export function checkFunds(f: Funds): void {
  finite("funds", f.available, f.used, f.total);
}
export function checkOrder(o: Order): void {
  named("order", o.symbol);
  finite(`order ${o.id}`, o.quantity, o.price, o.avgPrice);
  if (o.side !== "BUY" && o.side !== "SELL") throw new Error(`order ${o.id}: side must be BUY or SELL`);
}

/**
 * The tests every broker must pass. `make` returns a provider that is logged in and backed by test data, plus a way to end
 * its session. Call it from the provider's own test file: `runBrokerContract("zerodha", async () => ({ provider, expireSession }))`.
 */
export function runBrokerContract(name: string, make: () => Promise<{ provider: BrokerProvider; expireSession(): void }>): void {
  describe(`broker contract: ${name}`, () => {
    it("is read only: no way to place, change or cancel an order exists", async () => {
      const { provider } = await make();
      expect(provider.capabilities.placeOrders).toBe(false);
      for (const method of ["placeOrder", "modifyOrder", "cancelOrder", "placeGtt"]) expect((provider as unknown as Record<string, unknown>)[method]).toBeUndefined();
    });

    it("returns normalized data: finite numbers, named symbols", async () => {
      const { provider } = await make();
      if (provider.capabilities.holdings) (await provider.holdings()).forEach(checkHolding);
      if (provider.capabilities.positions) (await provider.positions()).forEach(checkPosition);
      if (provider.capabilities.funds) checkFunds(await provider.funds());
      if (provider.capabilities.orders) (await provider.orders()).forEach(checkOrder);
    });

    it("says the session ended, as a session error, once it has", async () => {
      const { provider, expireSession } = await make();
      expireSession();
      const kinds: string[] = [];
      for (const call of [() => provider.holdings(), () => provider.positions(), () => provider.funds(), () => provider.orders()]) {
        await call().catch((e: unknown) => kinds.push(e instanceof BrokerError ? e.kind : "not-a-broker-error"));
      }
      expect(kinds).toEqual(["session", "session", "session", "session"]);
    });

    it("forgets the session when it is cleared", async () => {
      const { provider } = await make();
      expect(provider.sessionExpiresAt()).not.toBeNull();
      provider.setSession(null);
      expect(provider.sessionExpiresAt()).toBeNull();
    });
  });
}
