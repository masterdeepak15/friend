import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageApi, UsageSummary } from "../../../settings/UsageTab";
import { localDayKey, useUsage } from "./useUsage";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const summary = (days: { day: string; input: number; output: number }[]): UsageSummary => ({ range: 30, days: days.map((d) => ({ ...d, turns: 1 })), total: { input: 0, output: 0, turns: 0 }, byModel: [], bySource: [] });
const api = (s: () => Promise<UsageSummary>): UsageApi & { calls: number } => {
  const a = { calls: 0, summary: () => (a.calls++, s()), clear: async () => ({ removed: 0 }) };
  return a;
};
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));

describe("useUsage", () => {
  it("gives today's share of the busiest day of the last 30", async () => {
    const today = localDayKey();
    const fetcher = api(async () => summary([{ day: "2020-01-01", input: 60, output: 40 }, { day: today, input: 30, output: 12 }]));
    const { result } = renderHook(() => useUsage(fetcher));
    await flush();
    expect(result.current).toMatchObject({ today: 42, peak: 100, error: false });
    expect(result.current.share).toBeCloseTo(0.42, 5);
  });

  it("has no share when nothing was ever used", async () => {
    const fetcher = api(async () => summary([]));
    const { result } = renderHook(() => useUsage(fetcher));
    await flush();
    expect(result.current.share).toBeNull();
  });

  it("is full on the busiest day itself", async () => {
    const today = localDayKey();
    const fetcher = api(async () => summary([{ day: today, input: 50, output: 50 }]));
    const { result } = renderHook(() => useUsage(fetcher));
    await flush();
    expect(result.current.share).toBe(1);
  });

  it("flags an error and keeps rendering when the request fails", async () => {
    const fetcher = api(async () => Promise.reject(new Error("down")));
    const { result } = renderHook(() => useUsage(fetcher));
    await flush();
    expect(result.current).toMatchObject({ share: null, error: true });
  });

  it("does not ask at all while it is switched off", async () => {
    const fetcher = api(async () => summary([]));
    renderHook(() => useUsage(fetcher, false));
    await flush();
    expect(fetcher.calls).toBe(0);
  });

  it("asks again every five minutes and stops when the screen goes away", async () => {
    const fetcher = api(async () => summary([]));
    const { unmount } = renderHook(() => useUsage(fetcher));
    await flush();
    expect(fetcher.calls).toBe(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(5 * 60_000)));
    expect(fetcher.calls).toBe(2);
    unmount();
    await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000)));
    expect(fetcher.calls).toBe(2);
  });
});
