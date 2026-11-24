import { describe, expect, it, vi } from "vitest";
import type { Match } from "./people";
import { Visitors } from "./visitors";

const face = (seed: number) => Array.from({ length: 128 }, (_, i) => Math.sin(seed * (i + 1)));
const priya: Match = { id: 1, name: "Priya", relation: "wife", share: "", score: 0.9 };

function rig(over: { enabled?: boolean; ok?: boolean } = {}) {
  let now = 10_000_000;
  const ask = vi.fn(async () => over.ok ?? true);
  const v = new Visitors({ enabled: () => over.enabled ?? true, ask, clock: () => now });
  const see = (n: number, seed = 5) => {
    for (let i = 0; i < n; i++) v.see([face(seed)], [null]);
  };
  return { v, ask, see, advance: (ms: number) => (now += ms) };
}

describe("Visitors", () => {
  it("asks about a lone stranger only after the same person was seen a few times in a row, and only once", async () => {
    const r = rig();
    r.see(2);
    expect(r.ask).not.toHaveBeenCalled();
    r.see(1);
    expect(r.ask).toHaveBeenCalledTimes(1);
    r.see(5);
    expect(r.ask).toHaveBeenCalledTimes(1);
    expect(r.v.pending()).not.toBeNull();
    expect(r.v.line()).toMatch(/people\.answer/);
  });

  it("does nothing while it is switched off, and when two different strangers pass by", () => {
    const off = rig({ enabled: false });
    off.see(10);
    expect(off.ask).not.toHaveBeenCalled();
    const r = rig();
    for (let i = 0; i < 6; i++) r.v.see([face(i + 1)], [null]);
    expect(r.ask).not.toHaveBeenCalled();
  });

  it("stays quiet while the owner is at the screen: the stranger could be the owner", () => {
    const r = rig();
    r.v.ownerActive();
    r.see(5);
    expect(r.ask).not.toHaveBeenCalled();
    r.advance(11 * 60_000);
    r.see(3);
    expect(r.ask).toHaveBeenCalledTimes(1);
  });

  it("does not ask when somebody known is in view too, or when there are two strangers", () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.v.see([face(1), face(5)], [priya, null]);
    for (let i = 0; i < 5; i++) r.v.see([face(5), face(6)], [null, null]);
    expect(r.ask).not.toHaveBeenCalled();
  });

  it("forgets the question when it could not be sent, and does not ask again within the cooldown", async () => {
    const r = rig({ ok: false });
    r.see(3);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.v.pending()).toBeNull();
    r.see(5);
    expect(r.ask).toHaveBeenCalledTimes(1); // the cooldown holds
    r.advance(31 * 60_000);
    r.see(3);
    expect(r.ask).toHaveBeenCalledTimes(2);
  });

  it("keeps the daily limit", () => {
    const r = rig({ ok: false });
    for (let d = 0; d < 10; d++) {
      r.see(3);
      r.advance(31 * 60_000);
    }
    expect(r.ask.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("an open question lapses after half an hour", () => {
    const r = rig();
    r.see(3);
    expect(r.v.pending()).not.toBeNull();
    r.advance(31 * 60_000);
    expect(r.v.pending()).toBeNull();
    expect(r.v.line()).toBe("");
  });

  it("'stranger' ends the question and the same face is not asked about again for an hour", () => {
    const r = rig();
    r.see(3);
    expect(r.v.resolve("stranger")).not.toBeNull();
    expect(r.v.pending()).toBeNull();
    r.advance(31 * 60_000);
    r.see(6);
    expect(r.ask).toHaveBeenCalledTimes(1);
    r.advance(31 * 60_000);
    r.see(3);
    expect(r.ask).toHaveBeenCalledTimes(2);
  });

  it("'known' hands the face numbers over once, and there is nothing left to answer afterwards", () => {
    const r = rig();
    r.see(3);
    const p = r.v.resolve("known");
    expect(p?.embedding).toHaveLength(128);
    expect(r.v.resolve("known")).toBeNull();
  });
});
