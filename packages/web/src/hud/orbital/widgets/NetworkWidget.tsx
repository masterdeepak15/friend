import type { HudStats } from "../../../store";
import { PulseLine } from "../kit";
import { STATS_STALE_MS } from "./SystemWidget";

/** 1536 becomes "1.5 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/** The network speed down and up. Some PCs have no cheap counter to read; then it says n/a instead of showing a flat zero. */
export function NetworkWidget({ stats, now = Date.now() }: { stats: HudStats | null; now?: number }) {
  if (!stats) return <p className="ob-li ob-sub">Waiting for data</p>;
  const none = stats.netDown === 0 && stats.netUp === 0;
  return (
    <div className="ob-network">
      <PulseLine />
      <p className="ob-li">{none ? "n/a" : `↓ ${formatBytes(stats.netDown)}/s ↑ ${formatBytes(stats.netUp)}/s`}</p>
      {now - stats.at > STATS_STALE_MS && <p className="ob-li ob-sub">Stale</p>}
    </div>
  );
}