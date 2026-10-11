import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sanitizeBrokers, saveConfig } from "../config";
import { applySettings, refuseForAgent, settingsView } from "../settings";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-brokers-"));
  return { dir, config: loadConfig(dir) };
};

describe("the defaults", () => {
  it("start with nothing installed, India's time zone, a 15 minute login reminder and read-only trading", () => {
    const { config } = fresh();
    expect(config.brokers).toEqual({
      zerodha: { installed: false, enabled: false, apiKey: "", apiSecret: null },
      timezone: "Asia/Kolkata",
      skipDates: [],
      loginReminderMinutes: 15,
      currencySymbol: "₹",
      currencyName: "rupees",
      numberLocale: "en-IN",
      concentrationPct: 30,
      bigDropPct: 5,
      cacheSeconds: 30,
      maxSchedules: 20,
      maxTriesPerDay: 3,
    });
    expect(config.trading).toEqual({ level: "read" });
  });
});

describe("what is read back from the saved file", () => {
  it("drops bad dates, keeps at most 100, and sorts and de-duplicates the rest", () => {
    const b = sanitizeBrokers({ skipDates: ["2026-10-02", "2026-13-40", "not a date", "2026-10-02", "2026-01-26", 5] });
    expect(b.skipDates).toEqual(["2026-01-26", "2026-10-02"]);
    const many = Array.from({ length: 150 }, (_, i) => `2027-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`);
    expect(sanitizeBrokers({ skipDates: many }).skipDates.length).toBeLessThanOrEqual(100);
  });

  it("keeps the reminder between 0 and 120 minutes", () => {
    expect(sanitizeBrokers({ loginReminderMinutes: -5 }).loginReminderMinutes).toBe(0);
    expect(sanitizeBrokers({ loginReminderMinutes: 9999 }).loginReminderMinutes).toBe(120);
    expect(sanitizeBrokers({ loginReminderMinutes: "soon" }).loginReminderMinutes).toBe(15);
  });

  it("falls back to India's time zone for one that does not exist", () => {
    expect(sanitizeBrokers({ timezone: "Mars/Olympus" }).timezone).toBe("Asia/Kolkata");
    expect(sanitizeBrokers({ timezone: "Europe/London" }).timezone).toBe("Europe/London");
  });

  it("counts a Zerodha that was set up earlier as installed, but not an empty one", () => {
    expect(sanitizeBrokers({ zerodha: { apiKey: "abc123" } }).zerodha.installed).toBe(true);
    expect(sanitizeBrokers({}).zerodha.installed).toBe(false);
  });

  it("reads a trading level other than read as read", () => {
    const { dir, config } = fresh();
    saveConfig({ ...config, trading: { level: "orders" } as never });
    expect(loadConfig(dir).trading.level).toBe("read");
  });
});

describe("changing them from the screen", () => {
  it("accepts the read-only level and refuses any other", () => {
    const { config } = fresh();
    expect(() => applySettings(config, { trading: { level: "read" } })).not.toThrow();
    expect(() => applySettings(config, { trading: { level: "orders" } })).toThrow();
    expect(() => applySettings(config, { trading: { level: "limits" } })).toThrow();
    expect(config.trading.level).toBe("read");
  });

  it("saves the key and the secret, and counts that as installing", () => {
    const { config } = fresh();
    const applied = applySettings(config, { brokers: { zerodha: { apiKey: "abc123", apiSecret: "SECRET123" } } });
    expect(config.brokers.zerodha).toMatchObject({ installed: true, apiKey: "abc123", apiSecret: "SECRET123" });
    expect(applied.changed).toEqual(expect.arrayContaining(["brokers.zerodha.apiKey", "brokers.zerodha.apiSecret"]));
  });

  it("leaves the saved secret alone when the field is sent empty", () => {
    const { config } = fresh();
    applySettings(config, { brokers: { zerodha: { apiKey: "abc123", apiSecret: "SECRET123" } } });
    applySettings(config, { brokers: { zerodha: { apiKey: "newkey1", apiSecret: "" } } });
    expect(config.brokers.zerodha).toMatchObject({ apiKey: "newkey1", apiSecret: "SECRET123" });
  });

  it("sets the time zone, the skipped dates and the reminder, and refuses nonsense", () => {
    const { config } = fresh();
    applySettings(config, { brokers: { timezone: "Asia/Kolkata", skipDates: ["2026-11-08", "2026-11-08"], loginReminderMinutes: 30 } });
    expect(config.brokers).toMatchObject({ timezone: "Asia/Kolkata", skipDates: ["2026-11-08"], loginReminderMinutes: 30 });
    expect(() => applySettings(config, { brokers: { timezone: "Mars/Olympus" } })).toThrow(/time zone/i);
    expect(() => applySettings(config, { brokers: { skipDates: ["tomorrow"] } })).toThrow();
    expect(() => applySettings(config, { brokers: { loginReminderMinutes: 500 } })).toThrow();
    expect(() => applySettings(config, { brokers: { zerodha: { surprise: 1 } } })).toThrow();
  });

  it("changes nothing when part of a change is refused", () => {
    const { config } = fresh();
    expect(() => applySettings(config, { brokers: { loginReminderMinutes: 30 }, trading: { level: "orders" } })).toThrow();
    expect(config.brokers.loginReminderMinutes).toBe(15);
  });
});

describe("what the screen is shown", () => {
  it("never includes the secret, only that one is set", () => {
    const { config } = fresh();
    applySettings(config, { brokers: { zerodha: { apiKey: "abc123", apiSecret: "SECRET123" } } });
    const view = settingsView(config);
    expect(JSON.stringify(view)).not.toContain("SECRET123");
    expect(view.brokers).toMatchObject({ zerodha: { installed: true, enabled: false, apiKey: "abc123", secretSet: true }, timezone: "Asia/Kolkata", skipDates: [], loginReminderMinutes: 15 });
    expect(view.trading).toEqual({ level: "read" });
  });
});

describe("what the assistant may not touch", () => {
  it("refuses the trading level and every broker setting, even with the PIN", () => {
    expect(() => refuseForAgent({ trading: { level: "read" } })).toThrow(/only be changed by the owner/);
    expect(() => refuseForAgent({ brokers: { zerodha: { apiKey: "x" } } })).toThrow(/only be changed by the owner/);
    expect(() => refuseForAgent({ voice: { speakTyped: true } })).not.toThrow();
  });
});
