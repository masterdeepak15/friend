import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runBrokerContract } from "./contract";
import { FakeKite } from "./testing/fakeKite";
import { BrokerError } from "./types";
import { createZerodha, nextSixIst } from "./zerodha";

const NOW = Date.UTC(2026, 9, 10, 4, 0, 0); // 09:30 in India on Saturday 10 October 2026
const FAR = NOW + 20 * 3600_000;

function setup(kite = new FakeKite()) {
  const provider = createZerodha({ apiKey: "KEY", apiSecret: "SECRET", fetch: kite.fetch, clock: () => NOW });
  provider.setSession({ accessToken: "ACCESS-1", expiresAt: FAR });
  return { kite, provider };
}

runBrokerContract("zerodha", async () => {
  const { kite, provider } = setup();
  return { provider, expireSession: () => (kite.tokenValid = false) };
});

describe("Zerodha login", () => {
  it("builds the login address with the one-time state passed through the redirect", () => {
    const { provider } = setup();
    if (provider.login.kind !== "redirect") throw new Error("Zerodha logs in by redirect");
    expect(provider.login.loginUrl("abc")).toBe("https://kite.zerodha.com/connect/login?v=3&api_key=KEY&redirect_params=state%3Dabc");
  });

  it("exchanges the request token with the SHA-256 checksum and gets a token that ends at 06:00 the next morning", async () => {
    const { kite, provider } = setup();
    provider.setSession(null);
    const token = kite.issueRequestToken();
    const session = await (provider.login as { complete(p: Record<string, string>): Promise<{ accessToken: string; expiresAt: number }> }).complete({ request_token: token, state: "abc" });
    expect(session).toEqual({ accessToken: "ACCESS-1", expiresAt: Date.UTC(2026, 9, 11, 0, 30, 0) }); // 06:00 IST
    const call = kite.requests.find((r) => r.path === "/session/token")!;
    expect(call.form.checksum).toBe(createHash("sha256").update(`KEY${token}SECRET`).digest("hex"));
    expect(call.form.api_key).toBe("KEY");
  });

  it("refuses a request token that is wrong or was already used, as an auth error", async () => {
    const { kite, provider } = setup();
    const complete = (provider.login as { complete(p: Record<string, string>): Promise<unknown> }).complete;
    await expect(complete({ request_token: "nope" })).rejects.toMatchObject({ kind: "auth" });
    const token = kite.issueRequestToken();
    await complete({ request_token: token });
    await expect(complete({ request_token: token })).rejects.toMatchObject({ kind: "auth" });
    await expect(complete({})).rejects.toMatchObject({ kind: "auth" });
  });

  it("knows 06:00 IST: before it the same day, after it the next day", () => {
    expect(nextSixIst(Date.UTC(2026, 9, 10, 0, 0, 0))).toBe(Date.UTC(2026, 9, 10, 0, 30, 0));
    expect(nextSixIst(Date.UTC(2026, 9, 10, 0, 30, 0))).toBe(Date.UTC(2026, 9, 11, 0, 30, 0));
    expect(nextSixIst(Date.UTC(2026, 9, 10, 23, 0, 0))).toBe(Date.UTC(2026, 9, 11, 0, 30, 0));
  });
});

describe("Zerodha reads", () => {
  it("sends the version header and the token header on every read, and only reads (GET)", async () => {
    const { kite, provider } = setup();
    await provider.holdings();
    await provider.positions();
    await provider.funds();
    await provider.orders();
    expect(kite.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /portfolio/holdings", "GET /portfolio/positions", "GET /user/margins", "GET /orders"]);
    for (const r of kite.requests) {
      expect(r.headers["x-kite-version"]).toBe("3");
      expect(r.headers.authorization).toBe("token KEY:ACCESS-1");
    }
  });

  it("maps holdings, adding the settled and the T+1 quantity", async () => {
    const { provider } = setup();
    expect(await provider.holdings()).toEqual([
      { symbol: "INFY", exchange: "NSE", quantity: 12, avgPrice: 1500, lastPrice: 1600, closePrice: 1590, pnl: 1200, dayChange: 10, dayChangePct: 0.63, product: "CNC" },
      { symbol: "TCS", exchange: "NSE", quantity: 5, avgPrice: 3500, lastPrice: 3400, closePrice: 3450, pnl: -500, dayChange: -50, dayChangePct: -1.45, product: "CNC" },
    ]);
  });

  it("maps the net positions, keeping a short as a negative quantity", async () => {
    const { provider } = setup();
    expect(await provider.positions()).toEqual([
      { symbol: "RELIANCE", exchange: "NSE", product: "MIS", quantity: 10, avgPrice: 2900, lastPrice: 2910, pnl: 100 },
      { symbol: "SBIN", exchange: "NSE", product: "MIS", quantity: -20, avgPrice: 800, lastPrice: 795, pnl: 100 },
    ]);
  });

  it("maps the equity margin: usable cash, what is used, and the total", async () => {
    const { provider } = setup();
    expect(await provider.funds()).toEqual({ available: 50000, used: 12000, total: 62000 });
  });

  it("maps today's orders", async () => {
    const { provider } = setup();
    expect(await provider.orders()).toEqual([{ id: "2610100001", symbol: "INFY", exchange: "NSE", side: "BUY", quantity: 2, price: 1590, avgPrice: 1589.5, type: "LIMIT", product: "CNC", status: "COMPLETE", at: "2026-10-10 09:20:11" }]);
  });

  it("copes with an empty account", async () => {
    const kite = new FakeKite();
    kite.holdings = [];
    kite.positions = { net: [], day: [] };
    kite.orders = [];
    const { provider } = setup(kite);
    expect(await provider.holdings()).toEqual([]);
    expect(await provider.positions()).toEqual([]);
    expect(await provider.orders()).toEqual([]);
  });
});

describe("Zerodha failures", () => {
  const kindOf = async (p: Promise<unknown>) => (await p.then(() => "ok", (e: unknown) => (e instanceof BrokerError ? e.kind : "other-error"))) as string;

  it("a rejected token is a session error and clears the session", async () => {
    const { kite, provider } = setup();
    kite.tokenValid = false;
    expect(await kindOf(provider.holdings())).toBe("session");
    expect(provider.sessionExpiresAt()).toBeNull();
  });

  it("without a session it does not even call Zerodha", async () => {
    const { kite, provider } = setup();
    provider.setSession(null);
    expect(await kindOf(provider.holdings())).toBe("session");
    expect(kite.requests).toEqual([]);
  });

  it("a session past its time is a session error without a call", async () => {
    const { kite, provider } = setup();
    provider.setSession({ accessToken: "ACCESS-1", expiresAt: NOW - 1 });
    expect(await kindOf(provider.holdings())).toBe("session");
    expect(kite.requests).toEqual([]);
  });

  it("429 is a rate error, 502 a network error, a thrown fetch a network error, 500 other", async () => {
    const { kite, provider } = setup();
    kite.failNext("/portfolio/holdings", 429);
    expect(await kindOf(provider.holdings())).toBe("rate");
    kite.failNext("/portfolio/positions", 502);
    expect(await kindOf(provider.positions())).toBe("network");
    kite.throwNext();
    expect(await kindOf(provider.funds())).toBe("network");
    kite.failNext("/orders", 500);
    expect(await kindOf(provider.orders())).toBe("other");
  });

  it("never puts the token, the secret or the key in an error message", async () => {
    const { kite, provider } = setup();
    kite.failNext("/portfolio/holdings", 500, "boom ACCESS-1 SECRET KEY");
    const err = (await provider.holdings().catch((e: unknown) => e)) as BrokerError;
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.message).not.toMatch(/ACCESS-1|SECRET|KEY/);
    expect(err.message).toMatch(/boom/);
  });
});
