import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  /** Cumulative bytes received and sent as last read (see refresh), or null when this PC gives no counter. */
  net?: () => { rx: number; tx: number } | null;
  now?: () => number;
  /** How the totals are read when refreshed (the PC's own counters by default). */
  readNet?: () => Promise<{ rx: number; tx: number } | null>;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The totals of `netstat -e` (Windows): the first line with two big numbers is the bytes, whatever the language of the PC. */
export function parseNetstatE(text: string): { rx: number; tx: number } | null {
  const m = /^\D*?(\d{3,})\s+(\d{3,})\s*$/m.exec(text);
  return m ? { rx: Number(m[1]), tx: Number(m[2]) } : null;
}

/** The totals of /proc/net/dev (Linux), every interface except the loopback. */
export function parseProcNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let found = false;
  for (const line of text.split("\n")) {
    const m = /^\s*([^\s:]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === "lo") continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    if (f.length < 9 || f.some((n) => !Number.isFinite(n))) continue;
    rx += f[0]!;
    tx += f[8]!;
    found = true;
  }
  return found ? { rx, tx } : null;
}

/** Reads this PC's network totals: from /proc on Linux, from the small `netstat -e` program on Windows; null elsewhere. */
export async function readNetTotals(): Promise<{ rx: number; tx: number } | null> {
  if (process.platform === "linux") return parseProcNetDev(await readFile("/proc/net/dev", "utf8"));
  if (process.platform === "win32") {
    const out = await new Promise<string>((resolve, reject) => execFile("netstat", ["-e"], { windowsHide: true, timeout: 3000 }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
    return parseNetstatE(out);
  }
  return null;
}

/** Turns the operating system's running totals into readings: processor share and network speed come from the change between two calls. */
export class StatsSampler {
  private lastCpu: { idle: number; total: number } | null = null;
  private lastNet: { rx: number; tx: number; at: number } | null = null;
  private totals: { rx: number; tx: number } | null = null;
  private readonly src: Required<SamplerSources>;

  constructor(sources: SamplerSources = {}) {
    this.src = { cpus: osCpus, totalmem: osTotalmem, freemem: osFreemem, net: () => this.totals, now: Date.now, readNet: readNetTotals, ...sources };
  }

  /** Reads the network totals (the next sample() uses them). A PC that gives none, or a failed read, leaves the speed at 0. */
  async refresh(read: () => Promise<{ rx: number; tx: number } | null> = this.src.readNet): Promise<void> {
    try {
      this.totals = await read();
    } catch {
      this.totals = null;
    }
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
    void opts.sampler.refresh().then(() => opts.emit({ type: "hud.stats", ...opts.sampler.sample() }));
  }, opts.intervalMs ?? HUD_STATS_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
