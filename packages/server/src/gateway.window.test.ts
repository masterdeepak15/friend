import { describe, expect, it } from "vitest";
import { SlidingWindow } from "./gateway";

describe("SlidingWindow", () => {
  it("allows up to max hits per window per key, then recovers", () => {
    let now = 0;
    const w = new SlidingWindow(3, 1000, () => now);
    expect([w.allow("a"), w.allow("a"), w.allow("a"), w.allow("a")]).toEqual([true, true, true, false]);
    expect(w.allow("b")).toBe(true); // keys are independent
    now = 1001;
    expect(w.allow("a")).toBe(true);
  });

  it("forgets keys that have gone quiet so memory does not grow without bound", () => {
    let now = 0;
    const w = new SlidingWindow(1, 1000, () => now);
    for (let i = 0; i < 5000; i++) w.allow(`session-${i}`);
    expect(w.size()).toBe(5000);
    now = 5000;
    w.allow("fresh");
    expect(w.size()).toBeLessThan(10);
  });
});
