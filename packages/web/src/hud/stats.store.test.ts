import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../store";

afterEach(() => vi.useRealTimers());

describe("the stats feed in the screen state", () => {
  it("starts with no stats", () => {
    expect(initialState.stats).toBeNull();
  });

  it("keeps the newest reading and the time it arrived", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const s = reduce(initialState, { type: "hud.stats", cpu: 38, ramUsed: 8e9, ramTotal: 16e9, netDown: 1500, netUp: 200 });
    expect(s.stats).toEqual({ cpu: 38, ramUsed: 8e9, ramTotal: 16e9, netDown: 1500, netUp: 200, at: 1_700_000_000_000 });
  });

  it("ignores a malformed reading", () => {
    const s = reduce(initialState, { type: "hud.stats", cpu: "lots" });
    expect(s).toBe(initialState);
  });
});
