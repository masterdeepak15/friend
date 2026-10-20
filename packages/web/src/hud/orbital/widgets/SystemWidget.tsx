import type { HudStats } from "../../../store";
import { ArcGauge } from "../kit";

/** A reading older than this is shown as stale. */
export const STATS_STALE_MS = 10_000;

/** The processor on a gauge and the memory share inside it. */
export function SystemWidget({ stats, now = Date.now() }: { stats: HudStats | null; now?: number }) {
  if (!stats) return <p className="ob-li ob-sub">Waiting for data</p>;
  const ram = stats.ramTotal > 0 ? Math.round((100 * stats.ramUsed) / stats.ramTotal) : 0;
  const stale = now - stats.at > STATS_STALE_MS;
  return (
    <div className="ob-system">
      <ArcGauge value={stats.cpu} inner={ram} label="CPU" />
      <p className="ob-li">CPU {Math.round(stats.cpu)}% · RAM {ram}%</p>
      {stale && <p className="ob-li ob-sub">Stale</p>}
    </div>
  );
}