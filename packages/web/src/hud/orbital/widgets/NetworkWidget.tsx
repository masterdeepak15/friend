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

/** The network speed down and up on a pulse line. Some PCs have no cheap counter to read; then it says n/a instead of a flat zero. */
export function NetworkWidget({ stats, now = Date.now() }: { stats: HudStats | null; now?: number }) {
  const none = !!stats && stats.netDown === 0 && stats.netUp === 0;
  const stale = !!stats && now - stats.at > STATS_STALE_MS;
  return (
    <svg className="ob-wsvg" viewBox="0 0 300 110">
      <text className="ob-lab" x="0" y="8">NETWORK</text>
      <PulseLine frame={{ x: 0, y: 20, w: 300, h: 70 }} />
      <text className="ob-dim" x="0" y="104">
        {!stats ? "Waiting for data" : none ? "n/a" : `↓ ${formatBytes(stats.netDown)}/s ↑ ${formatBytes(stats.netUp)}/s`}
        {stale ? " · stale" : ""}
      </text>
    </svg>
  );
}