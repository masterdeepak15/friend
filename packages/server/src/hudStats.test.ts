import { afterEach, describe, expect, it, vi } from "vitest";
import { HUD_STATS_INTERVAL_MS, StatsSampler, parseNetstatE, parseProcNetDev, startStatsFeed } from "./hudStats";

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
  const sampler = () => new StatsSampler({ cpus: () => cpu(50, 50), totalmem: () => 2, freemem: () => 1, readNet: async () => null });

  it("sends a reading every interval while it is wanted", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stop = startStatsFeed({ sampler: sampler(), wanted: () => true, emit });
    await vi.advanceTimersByTimeAsync(HUD_STATS_INTERVAL_MS * 2);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0]![0]).toMatchObject({ type: "hud.stats", ramTotal: 2, ramUsed: 1 });
    stop();
  });

  it("sends nothing while it is not wanted, and starts when it becomes wanted", async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    let on = false;
    const stop = startStatsFeed({ sampler: sampler(), wanted: () => on, emit });
    await vi.advanceTimersByTimeAsync(HUD_STATS_INTERVAL_MS * 3);
    expect(emit).not.toHaveBeenCalled();
    on = true;
    await vi.advanceTimersByTimeAsync(HUD_STATS_INTERVAL_MS);
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

describe("reading the network counters", () => {
  const WINDOWS = ["Interface Statistics", "", "                           Received            Sent", "", "Bytes                 123456789       987654321", "Unicast packets           100000          90000", "Errors                         0              0"].join("\r\n");
  const OTHER_LANGUAGE = ["Statistiques d''interface", "", "                           Reçus            Envoyés", "", "Octets                 5000000        3000000", "Paquets monodiffusion      10     20"].join("\n");
  const LINUX = ["Inter-|   Receive                                                |  Transmit", " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed", "    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0", "  eth0: 5000 50 0 0 0 0 0 0 2000 20 0 0 0 0 0 0", "  wlan0: 700 7 0 0 0 0 0 0 300 3 0 0 0 0 0 0"].join("\n");

  it("takes the bytes line of netstat -e whatever the language of the PC", () => {
    expect(parseNetstatE(WINDOWS)).toEqual({ rx: 123456789, tx: 987654321 });
    expect(parseNetstatE(OTHER_LANGUAGE)).toEqual({ rx: 5000000, tx: 3000000 });
    expect(parseNetstatE("nothing useful")).toBeNull();
  });

  it("adds up the interfaces of /proc/net/dev except the loopback", () => {
    expect(parseProcNetDev(LINUX)).toEqual({ rx: 5700, tx: 2300 });
    expect(parseProcNetDev("")).toBeNull();
  });

  it("turns two readings into a speed once refreshed twice", async () => {
    let now = 0;
    const reads = [{ rx: 1000, tx: 100 }, { rx: 3000, tx: 300 }];
    const s = new StatsSampler({ now: () => now, totalmem: () => 1, freemem: () => 1, cpus: () => [] });
    await s.refresh(async () => reads.shift()!);
    expect(s.sample().netDown).toBe(0);
    now = 2000;
    await s.refresh(async () => reads.shift()!);
    expect(s.sample()).toMatchObject({ netDown: 1000, netUp: 100 });
  });

  it("stays at 0 when there is no counter or reading it fails", async () => {
    const s = new StatsSampler({ totalmem: () => 1, freemem: () => 1, cpus: () => [] });
    await s.refresh(async () => {
      throw new Error("no netstat");
    });
    expect(s.sample()).toMatchObject({ netDown: 0, netUp: 0 });
  });
});