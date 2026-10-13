import { describe, expect, it, vi } from "vitest";
import { DuckController } from "./duck";

function make(over: { enabled?: boolean; percent?: number } = {}) {
  const state = { enabled: over.enabled ?? true, percent: over.percent ?? 25 };
  const apply = vi.fn();
  const duck = new DuckController({ enabled: () => state.enabled, percent: () => state.percent, apply });
  return { duck, apply, state };
}

describe("turning music and video down while someone talks", () => {
  it("turns them down while a screen is listening or Friend is speaking, and back up after", () => {
    const { duck, apply } = make();
    duck.set("a", true);
    expect(apply).toHaveBeenLastCalledWith(0.25);
    duck.set("a", false);
    expect(apply).toHaveBeenLastCalledWith(1);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("says nothing when nothing changed", () => {
    const { duck, apply } = make();
    duck.set("a", false);
    duck.set("a", true);
    duck.set("a", true);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("stays down until every screen that asked is done", () => {
    const { duck, apply } = make();
    duck.set("a", true);
    duck.set("b", true);
    duck.set("a", false);
    expect(duck.level).toBe(0.25);
    duck.set("b", false);
    expect(duck.level).toBe(1);
    expect(apply).toHaveBeenLastCalledWith(1);
  });

  it("lets go of what a screen asked for when that screen goes away", () => {
    const { duck, apply } = make();
    duck.set("a", true);
    duck.drop("a");
    expect(duck.level).toBe(1);
    expect(apply).toHaveBeenLastCalledWith(1);
    duck.drop("never-asked"); // harmless
  });

  it("does nothing when the owner has switched it off", () => {
    const { duck, apply } = make({ enabled: false });
    duck.set("a", true);
    expect(duck.level).toBe(1);
    expect(apply).not.toHaveBeenCalled();
  });

  it("follows a change of the settings while it is down", () => {
    const { duck, apply, state } = make();
    duck.set("a", true);
    state.percent = 50;
    duck.refresh();
    expect(apply).toHaveBeenLastCalledWith(0.5);
    state.enabled = false;
    duck.refresh();
    expect(apply).toHaveBeenLastCalledWith(1);
  });

  it("takes 0 as silence and 100 as no change", () => {
    const quiet = make({ percent: 0 });
    quiet.duck.set("a", true);
    expect(quiet.apply).toHaveBeenLastCalledWith(0);
    const same = make({ percent: 100 });
    same.duck.set("a", true);
    expect(same.apply).not.toHaveBeenCalled();
  });

  it("keeps the level between 0 and 1 whatever the setting says", () => {
    const wild = make({ percent: 500 });
    wild.duck.set("a", true);
    expect(wild.duck.level).toBe(1);
    const neg = make({ percent: -5 });
    neg.duck.set("a", true);
    expect(neg.duck.level).toBe(0);
    const nan = make({ percent: Number.NaN });
    nan.duck.set("a", true);
    expect(nan.duck.level).toBe(0.25);
  });
});
