import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Fallback2D } from "./fallback2d";
import { PresenceCore } from "./core";
import { createPresence } from "./factory";
import { Presence } from "./Presence";
import { RingPresence, ringBars } from "./ring";

describe("ringBars", () => {
  it("returns one value per bar, all within 0..1", () => {
    const bars = ringBars(96, 1.3, 0.8, 0.2);
    expect(bars).toHaveLength(96);
    for (const v of bars) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
  it("grows with amplitude and is deterministic for equal inputs", () => {
    const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
    expect(sum(ringBars(96, 2, 1, 0.1))).toBeGreaterThan(sum(ringBars(96, 2, 0, 0.1)));
    expect(ringBars(40, 0.5, 0.3, 0.1)).toEqual(ringBars(40, 0.5, 0.3, 0.1));
  });
  it("copes with a zero count and non-finite input", () => {
    expect(ringBars(0, 0, 0, 0)).toEqual([]);
    for (const v of ringBars(8, Number.NaN, Number.POSITIVE_INFINITY, Number.NaN)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("PresenceCore intensity", () => {
  it("scales brightness with mood intensity", () => {
    const run = (i: number) => {
      const c = new PresenceCore();
      c.setIntensity(i);
      for (let k = 0; k < 300; k++) c.tick(1 / 60);
      return c.uniforms().brightness;
    };
    expect(run(1)).toBeGreaterThan(run(0.6));
    expect(run(0.6)).toBeGreaterThan(run(0));
  });
  it("keeps the default look unchanged at the default intensity", () => {
    const c = new PresenceCore();
    for (let k = 0; k < 300; k++) c.tick(1 / 60);
    expect(c.uniforms().brightness).toBeCloseTo(0.85, 2);
  });
  it("clamps intensity to 0..1", () => {
    const c = new PresenceCore();
    c.setIntensity(5);
    expect(c.intensity).toBe(1);
    c.setIntensity(Number.NaN);
    expect(c.intensity).toBe(0);
  });
});

describe("createPresence", () => {
  const opts = { accent: "#3fd8ff", reducedMotion: false };
  it("returns a ring handle for ring, without needing WebGL", () => {
    const host = document.createElement("div");
    const h = createPresence("ring", host, opts);
    expect(h).toBeInstanceOf(RingPresence);
    expect(host.querySelectorAll("canvas")).toHaveLength(1);
    h.dispose();
    expect(host.querySelectorAll("canvas")).toHaveLength(0);
  });
  it("falls back to the 2D sphere for sphere and orb when WebGL is missing", () => {
    for (const style of ["sphere", "orb"] as const) {
      const host = document.createElement("div");
      const h = createPresence(style, host, opts);
      expect(h).toBeInstanceOf(Fallback2D);
      h.dispose();
    }
  });
  it("treats an unknown style as the sphere", () => {
    const host = document.createElement("div");
    const h = createPresence("hologram" as never, host, opts);
    expect(h).toBeInstanceOf(Fallback2D);
    h.dispose();
  });
  it("offers the full handle API on every style", () => {
    for (const style of ["sphere", "orb", "ring"] as const) {
      const h = createPresence(style, document.createElement("div"), opts);
      for (const fn of ["setState", "setAmplitude", "setMode", "setAccent", "setIntensity", "dispose"] as const) {
        expect(typeof h[fn]).toBe("function");
      }
      h.setState("speaking");
      h.setAmplitude(0.7);
      h.setIntensity(0.9);
      h.dispose();
    }
  });
});

describe("<Presence> style switching", () => {
  it("recreates the handle on style change and never leaves more than one canvas", () => {
    const { container, rerender } = render(<Presence state="idle" amplitude={0} mode="full" style="sphere" />);
    for (const style of ["ring", "orb", "ring", "sphere", "ring"] as const) {
      rerender(<Presence state="idle" amplitude={0} mode="full" style={style} />);
      expect(container.querySelectorAll("canvas")).toHaveLength(1);
    }
  });
  it("removes its canvas on unmount", () => {
    const { container, unmount } = render(<Presence state="idle" amplitude={0} mode="full" style="ring" />);
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    unmount();
    expect(document.querySelectorAll("canvas")).toHaveLength(0);
  });
});
