import { afterEach, describe, expect, it, vi } from "vitest";
import { HUD_STATS_INTERVAL_MS, StatsSampler, startStatsFeed } from "./hudStats";

afterEach(() => vi.useRealTimers());

const cpu = (idle: number, busy: number) => [{ model: "x", speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }];

describe("StatsSampler", () => {
  it("reports no processor use the first time, then the busy share since the last reading", () => {
    let now = [cpu(900, 100), cpu(940, 160)];
    const s = new StatsSampler({ cpus: () => now.shift()!, totalmem: () => 16e9, freemem: () => 6e9, net: () => null });
    expect(s.sample().cpu).toBe(0);
    expect(s.sample().cpu).toBe(60);
  });

  it("passes the memory through as used and total", () => {
    const s = new StatsSampler({ cpus: () => cpu(1, 1), totalmem: () => 16e9, freemem: () => 6e9, net: () => null });
    expect(s.sample()).toMatchObject({ ramUsed: 10e9, ramTotal: 16e9 });
  });

  it("reports no network when there is no counter", () => {
    const s = new StatsSampler({ cpus: () => cpu(1, 1), totalmem: () => 1, freemem: () => 1, net: () => null });
    expect(s.sample()).toMatchObject({ netDown: 0, netUp: 0 });
  });

  it("works out bytes a second from the counters, and never goes negative when they restart", () => {
    let t = 0;
    const counters = [{ rx: 1000, tx: 100 }, { rx: 3000, tx: 300 }, { rx: 10, tx: 5 }];
    const s = new StatsSampler({ cpus: () => cpu(1, 1), totalmem: () => 1, freemem: () => 1, net: () => counters.shift()!, now: () => (t += 2000) });
    expect(s.sample()).toMatchObject({ netDown: 0, netUp: 0 });
    expect(s.sample()).toMatchObject({ netDown: 1000, netUp: 100 });
    expect(s.sample()).toMatchObject({ netDown: 0, netUp: 0 });
  });

  it("keeps the processor share between 0 and 100 even when the counters go backwards", () => {
    const readings = [cpu(900, 100), cpu(10, 10)];
    const s = new StatsSampler({ cpus: () => readings.shift()!, totalmem: () => 1, freemem: () => 1, net: () => null });
    s.sample();
    const c = s.sample().cpu;
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(100);
  });
});

describe("startStatsFeed", () => {
  const sampler = () => new StatsSampler({ cpus: () => cpu(50, 50), totalmem: () => 2, freemem: () => 1, net: () => null });

  it("sends a reading every interval while it is wanted", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stop = startStatsFeed({ sampler: sampler(), wanted: () => true, emit });
    vi.advanceTimersByTime(HUD_STATS_INTERVAL_MS * 2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toMatchObject({ type: "hud.stats", ramTotal: 2, ramUsed: 1 });
    stop();
  });

  it("sends nothing while it is not wanted, and starts when it becomes wanted", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    let on = false;
    const stop = startStatsFeed({ sampler: sampler(), wanted: () => on, emit });
    vi.advanceTimersByTime(HUD_STATS_INTERVAL_MS * 3);
    expect(emit).not.toHaveBeenCalled();
    on = true;
    vi.advanceTimersByTime(HUD_STATS_INTERVAL_MS);
    expect(emit).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops for good when told to", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stop = startStatsFeed({ sampler: sampler(), wanted: () => true, emit });
    stop();
    vi.advanceTimersByTime(HUD_STATS_INTERVAL_MS * 5);
    expect(emit).not.toHaveBeenCalled();
  });
});
