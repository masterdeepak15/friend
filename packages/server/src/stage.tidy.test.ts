import type { ScreenInfo, StageObject } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { StageState } from "./stage";

const DESKTOP: ScreenInfo = { width: 1920, height: 1080, kind: "desktop", orientation: "landscape", touch: false };
const CFG = { dockAfterSeconds: 40, maxChips: null, autoTidy: true };
const show = (s: StageState, o: Partial<StageObject> & { id: string }, at: number) =>
  s.apply({ cmd: "show", object: { type: "card", props: { text: o.id }, placement: "auto", ...o } }, at);
const docked = (s: StageState) => s.snapshot().objects.filter((o) => o.docked).map((o) => o.id);

describe("StageState.tidy puts finished cards away", () => {
  it("docks a beside card only after the dock time", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    show(s, { id: "b", role: "beside" }, 0);
    expect(s.tidy(39_000, CFG)).toEqual([]);
    expect(s.tidy(40_000, CFG)).toEqual([{ cmd: "dock", id: "b", docked: true }]);
    expect(docked(s)).toEqual(["b"]);
  });
  it("waits for the reading time of a long text even when the dock time is short", () => {
    const s = new StageState();
    show(s, { id: "long", role: "beside", props: { text: "x".repeat(1500) } }, 0); // 101.5 s to read
    expect(s.tidy(60_000, { ...CFG, dockAfterSeconds: 10 })).toEqual([]);
    expect(s.tidy(102_000, { ...CFG, dockAfterSeconds: 10 })).toHaveLength(1);
  });
  it("does nothing when the time is 0 or auto-tidy is off", () => {
    const s = new StageState();
    show(s, { id: "b", role: "beside" }, 0);
    expect(s.tidy(10_000_000, { ...CFG, dockAfterSeconds: 0 })).toEqual([]);
    expect(s.tidy(10_000_000, { ...CFG, autoTidy: false })).toEqual([]);
  });
  it("never docks a focus, an alert, a note, a pinned widget or an owner-placed card", () => {
    const s = new StageState();
    show(s, { id: "f", role: "focus" }, 0);
    show(s, { id: "a", role: "alert" }, 0);
    show(s, { id: "n", role: "note", layer: "overlay", ttl: 600 }, 0);
    show(s, { id: "w", role: "beside", pinned: true }, 0);
    show(s, { id: "o", role: "beside" }, 0);
    s.apply({ cmd: "place", id: "o", placement: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } }, 0, true);
    expect(s.tidy(1_000_000, CFG)).toEqual([]);
  });
  it("a card with no role is left alone (only roles say what may be put away)", () => {
    const s = new StageState();
    show(s, { id: "plain" }, 0);
    expect(s.tidy(1_000_000, CFG)).toEqual([]);
  });
  it("an update restarts the timer", () => {
    const s = new StageState();
    show(s, { id: "b", role: "beside" }, 0);
    s.apply({ cmd: "update", id: "b", props: { text: "fresh" } }, 30_000);
    expect(s.tidy(60_000, CFG)).toEqual([]);
    expect(s.tidy(70_000, CFG)).toHaveLength(1);
  });
});
