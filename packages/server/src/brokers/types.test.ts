import { describe, expect, it } from "vitest";
import { checkHolding } from "./contract";
import { BrokerError, type Holding } from "./types";

const holding: Holding = { symbol: "INFY", exchange: "NSE", quantity: 10, avgPrice: 1500, lastPrice: 1600, closePrice: 1590, pnl: 1000, dayChange: 10, dayChangePct: 0.63, product: "CNC" };

describe("the broker contract", () => {
  it("BrokerError keeps what kind of failure it was", () => {
    const e = new BrokerError("login expired", "session");
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("session");
    expect(e.message).toBe("login expired");
  });

  it("accepts a sane holding", () => {
    expect(() => checkHolding(holding)).not.toThrow();
  });

  it("refuses a holding with a number that is not finite or an empty symbol", () => {
    expect(() => checkHolding({ ...holding, quantity: Number.NaN })).toThrow(/finite/);
    expect(() => checkHolding({ ...holding, pnl: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => checkHolding({ ...holding, symbol: "" })).toThrow(/symbol/);
  });
});
