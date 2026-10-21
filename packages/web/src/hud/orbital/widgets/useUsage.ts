import { useEffect, useState } from "react";
import { httpUsageApi, type UsageApi } from "../../../settings/UsageTab";

/** How often the usage is asked for again. */
export const USAGE_REFRESH_MS = 5 * 60_000;

/** Today's date on this device, as the usage log writes its days (YYYY-MM-DD). */
export const localDayKey = (d: Date = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export interface UsageShare {
  /** Tokens used today. */
  today: number;
  /** Tokens on the busiest of the last 30 days. */
  peak: number;
  /** Today relative to the busiest day, 0..1; null when nothing has ever been used or it is not known. The Claude subscription exposes no usage-window percentage, so this is the honest measure. */
  share: number | null;
  error: boolean;
}

const EMPTY: UsageShare = { today: 0, peak: 0, share: null, error: false };

/** Reads the usage log once, then every five minutes while `enabled`. */
export function useUsage(api: UsageApi = httpUsageApi, enabled = true): UsageShare {
  const [usage, setUsage] = useState<UsageShare>(EMPTY);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () =>
      api
        .summary(30)
        .then((s) => {
          if (!live) return;
          const totals = s.days.map((d) => ({ day: d.day, n: d.input + d.output }));
          const peak = Math.max(0, ...totals.map((t) => t.n));
          const today = totals.find((t) => t.day === localDayKey())?.n ?? 0;
          setUsage({ today, peak, share: peak > 0 ? Math.min(1, Math.max(0, today / peak)) : null, error: false });
        })
        .catch(() => live && setUsage({ ...EMPTY, error: true }));
    void load();
    const id = setInterval(() => void load(), USAGE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api, enabled]);
  return usage;
}