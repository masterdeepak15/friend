export type WatchState = "unknown" | "up" | "down";
export interface WatchTrack {
  state: WatchState;
  fails: number;
}

/**
 * What one more check does to a watch. It goes down only after two failed checks in a row (one blip is not an alert), comes back up on the
 * first good one, and `changed` says so exactly once: a watch that stays down or stays up changes nothing and wakes nobody.
 */
export function nextWatchState(prev: WatchTrack, ok: boolean): WatchTrack & { changed: "down" | "up" | null } {
  if (ok) return { state: "up", fails: 0, changed: prev.state === "down" ? "up" : null };
  const fails = prev.fails + 1;
  if (fails >= 2 && prev.state !== "down") return { state: "down", fails, changed: "down" };
  return { state: prev.state, fails, changed: null };
}
