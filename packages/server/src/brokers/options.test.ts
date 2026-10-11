import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { loadConfig, sanitizeBrokers } from "../config";
import { openDb } from "../db";
import { applySettings, settingsView } from "../settings";
import { BrokerHub } from "./hub";
import { formatMoney } from "./money";
import { Portfolio, type PortfolioSnapshot } from "./portfolio";
import { buildReport, formatInr } from "./report";
import { ReportSchedules } from "./schedules";
import { ReportScheduler } from "./scheduler";
import { partText } from "./tooltext";
import { FakeKite } from "./testing/fakeKite";
import { portfolioSpeech } from "../alexa/fast";
import { summarize } from "./portfolio";
import type { BrokerProvider } from "./types";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-brokeropts-"));
  return { dir, config: loadConfig(dir) };
};

describe("the defaults are today's behaviour", () => {
  it("rupees, Indian grouping, 30% and 5% warnings, 30 s cache, 20 schedules, 3 tries", () => {
    const { config } = fresh();
    expect(config.brokers).toMatchObject({ currencySymbol: "₹", currencyName: "rupees", numberLocale: "en-IN", concentrationPct: 30, bigDropPct: 5, cacheSeconds: 30, maxSchedules: 20, maxTriesPerDay: 3 });
  });
});

describe("what is read back from the saved file", () => {
  it("keeps every value inside its range, and falls back to the default for nonsense", () => {
    const b = sanitizeBrokers({ cacheSeconds: 9999, maxSchedules: 0, maxTriesPerDay: 99, concentrationPct: 1, bigDropPct: 80, numberLocale: "not a locale", currencySymbol: "", currencyName: "x".repeat(50) });
    expect(b).toMatchObject({ cacheSeconds: 300, maxSchedules: 1, maxTriesPerDay: 10, concentrationPct: 5, bigDropPct: 50, numberLocale: "en-IN", currencySymbol: "₹" });
    expect(b.currencyName.length).toBeLessThanOrEqual(20);
    expect(sanitizeBrokers({ cacheSeconds: "soon" }).cacheSeconds).toBe(30);
  });
});

describe("changing them from the screen", () => {
  const patch = { brokers: { currencySymbol: "$", currencyName: "dollars", numberLocale: "en-US", concentrationPct: 40, bigDropPct: 8, cacheSeconds: 60, maxSchedules: 5, maxTriesPerDay: 2 } };

  it("saves them, and shows them back", () => {
    const { config } = fresh();
    const applied = applySettings(config, patch);
    expect(config.brokers).toMatchObject(patch.brokers);
    expect(applied.changed).toEqual(expect.arrayContaining(["brokers.currencySymbol", "brokers.cacheSeconds", "brokers.maxSchedules"]));
    expect(settingsView(config).brokers).toMatchObject(patch.brokers);
  });

  it("refuses a value outside its range, a locale nobody knows, and an over-long symbol, changing nothing", () => {
    const { config } = fresh();
    for (const bad of [{ concentrationPct: 95 }, { bigDropPct: 0 }, { cacheSeconds: 1 }, { maxSchedules: 51 }, { maxTriesPerDay: 0 }, { numberLocale: "xx-bad-locale" }, { currencySymbol: "12345" }]) {
      expect(() => applySettings(config, { brokers: { ...patch.brokers, ...bad } })).toThrow();
    }
    expect(config.brokers.currencySymbol).toBe("₹");
  });
});

describe("the money formatter", () => {
  it("is the same as before by default: lakh grouping, no -0.00", () => {
    expect(formatMoney(123456.5)).toBe("₹1,23,456.50");
    expect(formatMoney(-2000)).toBe("-₹2,000.00");
    expect(formatMoney(-0.001)).toBe("₹0.00");
    expect(formatMoney(Number.NaN)).toBe("₹0.00");
    expect(formatInr(12345678.9)).toBe("₹1,23,45,678.90");
  });

  it("follows the owner's symbol and number locale", () => {
    expect(formatMoney(1234567.5, { symbol: "$", locale: "en-US" })).toBe("$1,234,567.50");
    expect(formatMoney(-1234.5, { symbol: "€", locale: "de-DE" })).toBe("-€1.234,50");
  });

  it("falls back to the default locale for one that is not valid", () => {
    expect(formatMoney(1234567, { symbol: "₹", locale: "nope" })).toBe("₹12,34,567.00");
  });
});

const snapshot = (): PortfolioSnapshot => ({
  at: Date.parse("2026-10-12T04:00:00Z"),
  holdings: {
    ok: true,
    data: [
      { symbol: "BIG", exchange: "NSE", quantity: 10, avgPrice: 100, lastPrice: 100, closePrice: 100, pnl: 0, dayChange: 0, dayChangePct: 0, product: "CNC" },
      { symbol: "SMALL", exchange: "NSE", quantity: 10, avgPrice: 100, lastPrice: 92, closePrice: 100, pnl: -80, dayChange: -80, dayChangePct: -8, product: "CNC" },
    ],
  },
  positions: { ok: true, data: [] },
  funds: { ok: true, data: { available: 1500, used: 500, total: 2000 } },
  orders: { ok: true, data: [] },
});
const caps = { holdings: true, positions: true, funds: true, orders: true, mutualFunds: false, quotes: false, placeOrders: false as const };
const input = { snapshot: snapshot(), kind: "custom" as const, caps, now: new Date("2026-10-12T04:00:00Z"), broker: "Test" };

describe("the report", () => {
  it("uses the owner's symbol and number locale", () => {
    const text = buildReport({ ...input, options: { money: { symbol: "$", locale: "en-US" }, concentrationPct: 30, bigDropPct: 5 } });
    expect(text).toContain("Portfolio: $1,920.00");
    expect(text).not.toContain("₹");
  });

  it("warns about concentration and a big drop at the owner's levels", () => {
    const defaults = buildReport(input);
    expect(defaults).toMatch(/BIG is 52\.1% of the portfolio/);
    expect(defaults).toMatch(/SMALL is down 8\.0% today/);
    const relaxed = buildReport({ ...input, options: { money: { symbol: "₹", locale: "en-IN" }, concentrationPct: 60, bigDropPct: 10 } });
    expect(relaxed).not.toMatch(/of the portfolio/);
    expect(relaxed).not.toMatch(/is down 8/);
  });
});

describe("the text the assistant reads, and what is spoken", () => {
  it("both follow the owner's symbol", () => {
    const text = partText("funds", snapshot(), "UTC", { symbol: "$", locale: "en-US" });
    expect(text).toContain("Available $1,500.00");
    const holdings = snapshot().holdings;
    if (!holdings.ok) throw new Error("fixture");
    const spoken = portfolioSpeech(summarize(holdings.data), "en", { money: { symbol: "$", locale: "en-US" }, currencyName: "dollars" });
    expect(spoken).toContain("dollars");
    expect(spoken).not.toContain("rupees");
  });
});

describe("the cache, the schedule limit and the tries", () => {
  it("keeps a read as long as the owner says, and the setting can change later", async () => {
    let now = 0;
    let seconds = 10;
    let reads = 0;
    const provider = {
      id: "t",
      name: "t",
      capabilities: caps,
      login: { kind: "credentials", fields: [], complete: async () => ({ accessToken: "", expiresAt: 0 }) },
      setSession() {},
      sessionExpiresAt: () => 1,
      holdings: async () => (reads++, []),
      positions: async () => [],
      funds: async () => ({ available: 0, used: 0, total: 0 }),
      orders: async () => [],
    } as unknown as BrokerProvider;
    const p = new Portfolio(provider, () => now, () => seconds * 1000);
    await p.snapshot();
    now = 9000;
    await p.snapshot();
    expect(reads).toBe(1);
    now = 11_000;
    await p.snapshot();
    expect(reads).toBe(2);
    seconds = 60;
    now = 50_000;
    await p.snapshot();
    now = 100_000;
    await p.snapshot();
    expect(reads).toBe(3); // the 60 s keep applied from the read at 50 s
  });

  it("limits the schedules to the owner's number", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-sched-"));
    let max = 2;
    const s = new ReportSchedules(openDb(dir), () => max);
    const one = { name: "A", broker: "zerodha", kind: "morning" as const, time: "09:30", days: [1], channel: "telegram" as const, commentary: false, enabled: true };
    s.add(one);
    s.add({ ...one, name: "B" });
    expect(() => s.add({ ...one, name: "C" })).toThrow(/at most 2/);
    max = 3;
    expect(() => s.add({ ...one, name: "C" })).not.toThrow();
  });

  it("gives up for the day after the owner's number of tries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-sched-"));
    const schedules = new ReportSchedules(openDb(dir));
    schedules.add({ name: "A", broker: "zerodha", kind: "morning", time: "09:30", days: [1, 2, 3, 4, 5, 6, 7], channel: "telegram", commentary: false, enabled: true });
    let tries = 0;
    const sched = new ReportScheduler({ schedules, zone: () => "UTC", skipDates: () => [], maxTries: () => 2, run: async () => { tries++; throw new Error("no"); } });
    for (let i = 0; i < 5; i++) await sched.tick(new Date("2026-10-12T10:00:00Z"));
    expect(tries).toBe(2);
  });
});

describe("the hub uses the settings as they are now", () => {
  it("a changed symbol shows in the next report without a restart", async () => {
    const { dir, config } = fresh();
    config.brokers.zerodha = { installed: true, enabled: true, apiKey: "KEY", apiSecret: "SECRET" };
    const db = openDb(dir);
    const kite = new FakeKite();
    const hub = new BrokerHub({ config, dataDir: dir, db, audit: new Audit(db), channels: { send: async () => ({ ok: true, summary: "" }) }, fetch: kite.fetch, publicBase: () => null });
    hub.apply();
    const state = new URL(hub.loginLink("zerodha")!).searchParams.get("redirect_params")!.replace("state=", "");
    await hub.completeLogin({ request_token: kite.issueRequestToken(), state });
    const before = await hub.report("zerodha");
    expect(before.ok && before.text).toContain("₹");
    config.brokers.currencySymbol = "$";
    config.brokers.numberLocale = "en-US";
    hub.apply();
    const after = await hub.report("zerodha");
    expect(after.ok && after.text).toContain("Portfolio: $");
  });
});
