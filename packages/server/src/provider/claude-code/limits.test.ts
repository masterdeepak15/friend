import { describe, expect, it } from "vitest";
import { isUsageLimit, parseResetDelayMs, usageLimitBackoffMs } from "./limits";

const NOW = new Date("2026-10-08T12:00:00Z"); // 17:30 in Asia/Calcutta

describe("isUsageLimit", () => {
  it.each([
    "You've hit your weekly limit · resets 2:30pm (Asia/Calcutta)",
    "You've hit your usage limit. It resets at 5:00pm (UTC).",
    "Claude usage limit reached",
    "5-hour limit reached ∙ resets 4:00pm (America/New_York)",
    "You have hit your daily limit",
  ])("recognizes: %s", (t) => expect(isUsageLimit(t)).toBe(true));

  it.each([
    "Here is the weather in Pune.",
    "The limit of this function as x goes to zero is one.",
    "I will speed up the rate limiting code.",
    "",
  ])("does not mistake ordinary text: %s", (t) => expect(isUsageLimit(t)).toBe(false));
});

describe("parseResetDelayMs", () => {
  it("reads 'resets 2:30pm (Asia/Calcutta)' as a delay until the next 2:30 pm there", () => {
    // 17:30 in Calcutta now, so 2:30 pm is tomorrow: 21 hours away
    expect(parseResetDelayMs("limit reached · resets 2:30pm (Asia/Calcutta)", NOW)).toBe(21 * 3_600_000);
  });

  it("uses the same day when the time is still ahead", () => {
    expect(parseResetDelayMs("resets 11:00pm (Asia/Calcutta)", NOW)).toBe(5.5 * 3_600_000);
  });

  it("understands 12 am and 12 pm", () => {
    expect(parseResetDelayMs("resets 12:00am (UTC)", NOW)).toBe(12 * 3_600_000);
    expect(parseResetDelayMs("resets 12:00pm (UTC)", new Date("2026-10-08T11:00:00Z"))).toBe(3_600_000);
  });

  it("gives up cleanly on anything it does not understand", () => {
    expect(parseResetDelayMs("resets sometime soon", NOW)).toBeUndefined();
    expect(parseResetDelayMs("resets 2:30pm (Not/AZone)", NOW)).toBeUndefined();
    expect(parseResetDelayMs("", NOW)).toBeUndefined();
  });
});

describe("usageLimitBackoffMs", () => {
  it("is the time until the reset when it can be read", () => {
    expect(usageLimitBackoffMs("You've hit your weekly limit · resets 11:00pm (Asia/Calcutta)", NOW)).toBe(5.5 * 3_600_000);
  });

  it("falls back to 15 minutes, and never goes below 30 seconds", () => {
    expect(usageLimitBackoffMs("You've hit your usage limit", NOW)).toBe(15 * 60_000);
    // 17:29:50 in Calcutta: the reset is 10 seconds away, which is too short to be worth waiting for exactly
    expect(usageLimitBackoffMs("hit your limit · resets 5:30pm (Asia/Calcutta)", new Date("2026-10-08T11:59:50Z"))).toBe(30_000);
  });

  it("is undefined for a different kind of failure", () => {
    expect(usageLimitBackoffMs("not logged in", NOW)).toBeUndefined();
  });
});
