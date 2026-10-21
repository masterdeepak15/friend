import type { HudStats } from "../../../store";
import { ArcGauge } from "../kit";

/** A reading older than this is shown as stale. */
export const STATS_STALE_MS = 10_000;

/** The processor on an arc gauge with the memory share on a thinner arc inside it, as in the approved mockup. */
export function SystemWidget({ stats, now = Date.now() }: { stats: HudStats | null; now?: number }) {
  const cpu = stats ? Math.round(stats.cpu) : 0;
  const ram = stats && stats.ramTotal > 0 ? Math.round((100 * stats.ramUsed) / stats.ramTotal) : 0;
  const stale = !!stats && now - stats.at > STATS_STALE_MS;
  return (
    <svg className="ob-wsvg" viewBox="0 0 300 220">
      <text className="ob-lab" x="12" y="8">SYSTEM · CPU / RAM</text>
      <path className="ob-bracket" d="M0 20H20M0 20V40M300 20H280M300 20V40" />
      <ArcGauge value={cpu} inner={ram} label="CPU" frame={{ x: 0, y: 20, w: 300, h: 190 }} />
      {stats ? (
        <>
          <text className="ob-big" x="150" y="170" textAnchor="middle">{cpu}%</text>
          <text className="ob-dim" x="150" y="192" textAnchor="middle">CPU · RAM {ram}%{stale ? " · STALE" : ""}</text>
        </>
      ) : (
        <text className="ob-dim" x="150" y="180" textAnchor="middle">Waiting for data</text>
      )}
    </svg>
  );
}