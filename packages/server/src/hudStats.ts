import { cpus as osCpus, freemem as osFreemem, totalmem as osTotalmem } from "node:os";
import type { ServerMsg } from "@friend/protocol";

/** How often the orbital screen gets a reading of how busy this PC is. */
export const HUD_STATS_INTERVAL_MS = 2000;

export interface Stats {
  /** Processor use since the last reading, 0..100. */
  cpu: number;
  ramUsed: number;
  ramTotal: number;
  /** Bytes a second; 0 when this PC has no cheap counter to read. */
  netDown: number;
  netUp: number;
}

export interface SamplerSources {
  cpus?: () => { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[];
  totalmem?: () => number;
  freemem?: () => number;
  /** Cumulative bytes received and sent, or null when there is no counter (no dependency and no shell is used to find one). */
  net?: () => { rx: number; tx: number } | null;
  now?: () => number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Turns the operating system's running totals into readings: processor share and network speed come from the change between two calls. */
export class StatsSampler {
  private lastCpu: { idle: number; total: number } | null = null;
  private lastNet: { rx: number; tx: number; at: number } | null = null;
  private readonly src: Required<SamplerSources>;

  constructor(sources: SamplerSources = {}) {
    this.src = { cpus: osCpus, totalmem: osTotalmem, freemem: osFreemem, net: () => null, now: Date.now, ...sources };
  }

  sample(): Stats {
    let idle = 0;
    let total = 0;
    for (const c of this.src.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    let cpu = 0;
    if (this.lastCpu) {
      const dTotal = total - this.lastCpu.total;
      const dIdle = idle - this.lastCpu.idle;
      if (dTotal > 0) cpu = clamp(Math.round(100 * (1 - dIdle / dTotal) * 10) / 10, 0, 100);
    }
    this.lastCpu = { idle, total };

    let netDown = 0;
    let netUp = 0;
    const net = this.src.net();
    const at = this.src.now();
    if (net && this.lastNet) {
      const seconds = (at - this.lastNet.at) / 1000;
      if (seconds > 0 && net.rx >= this.lastNet.rx && net.tx >= this.lastNet.tx) {
        netDown = Math.round((net.rx - this.lastNet.rx) / seconds);
        netUp = Math.round((net.tx - this.lastNet.tx) / seconds);
      } // counters that went backwards (an adapter restarted) give 0, never a negative speed
    }
    this.lastNet = net ? { rx: net.rx, tx: net.tx, at } : null;

    const ramTotal = this.src.totalmem();
    return { cpu, ramUsed: Math.max(0, ramTotal - this.src.freemem()), ramTotal, netDown, netUp };
  }
}

/** Sends a reading every interval while `wanted()` says so (read each time, so a settings change takes effect without a restart). Returns a function that stops it. */
export function startStatsFeed(opts: { sampler: StatsSampler; wanted: () => boolean; emit: (m: ServerMsg) => void; intervalMs?: number }): () => void {
  const timer = setInterval(() => {
    if (!opts.wanted()) return;
    opts.emit({ type: "hud.stats", ...opts.sampler.sample() });
  }, opts.intervalMs ?? HUD_STATS_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
