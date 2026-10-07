import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { pickParticleCount } from "./capability";
import { PresenceCore } from "./core";
import { Presence } from "./Presence";
import { fibonacciSphere } from "./sphere";

describe("fibonacciSphere", () => {
  it("returns count*3 floats, each point on the unit sphere", () => {
    const pts = fibonacciSphere(1000);
    expect(pts).toBeInstanceOf(Float32Array);
    expect(pts.length).toBe(3000);
    for (let i = 0; i < 1000; i++) {
      const len = Math.hypot(pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!);
      expect(Math.abs(len - 1)).toBeLessThan(1e-5);
    }
  });
  it("spreads points over both hemispheres", () => {
    const pts = fibonacciSphere(500);
    const ys = Array.from({ length: 500 }, (_, i) => pts[i * 3 + 1]!);
    expect(Math.min(...ys)).toBeLessThan(-0.9);
    expect(Math.max(...ys)).toBeGreaterThan(0.9);
  });
});

describe("pickParticleCount", () => {
  it("stays between 6000 and 12000 with WebGL", () => {
    for (const memoryGb of [undefined, 1, 4, 8, 32]) {
      const n = pickParticleCount({ webgl: true, memoryGb, reducedMotion: false });
      expect(n).toBeGreaterThanOrEqual(6000);
      expect(n).toBeLessThanOrEqual(12000);
    }
  });
  it("returns 0 without WebGL so the 2D fallback is used", () => {
    expect(pickParticleCount({ webgl: false, memoryGb: 16, reducedMotion: false })).toBe(0);
  });
  it("uses the smallest count when reduced motion is requested", () => {
    expect(pickParticleCount({ webgl: true, memoryGb: 32, reducedMotion: true })).toBe(6000);
  });
});

describe("PresenceCore", () => {
  it("clamps amplitude to 0..1", () => {
    const c = new PresenceCore();
    c.setAmplitude(2);
    expect(c.amplitudeTarget).toBe(1);
    c.setAmplitude(-1);
    expect(c.amplitudeTarget).toBe(0);
    c.setAmplitude(Number.NaN);
    expect(c.amplitudeTarget).toBe(0);
  });
  it("moves its parameters toward the target state over time", () => {
    const c = new PresenceCore();
    for (let i = 0; i < 120; i++) c.tick(1 / 60);
    const idle = c.uniforms();
    c.setState("speaking");
    for (let i = 0; i < 120; i++) c.tick(1 / 60);
    const speaking = c.uniforms();
    expect(speaking.brightness).toBeGreaterThan(idle.brightness);
    expect(speaking.speed).toBeGreaterThan(idle.speed);
  });
  it("gives each of the four states distinct settings", () => {
    const seen = new Set<string>();
    for (const s of ["idle", "listening", "thinking", "speaking"] as const) {
      const c = new PresenceCore();
      c.setState(s);
      for (let i = 0; i < 300; i++) c.tick(1 / 60);
      const u = c.uniforms();
      seen.add([u.speed, u.noise, u.brightness, u.rotate].map((n) => n.toFixed(2)).join("|"));
    }
    expect(seen.size).toBe(4);
  });
  it("lets the smoothed amplitude follow the target and decay back to zero", () => {
    const c = new PresenceCore();
    c.setAmplitude(1);
    for (let i = 0; i < 20; i++) c.tick(1 / 60);
    expect(c.uniforms().amplitude).toBeGreaterThan(0.3);
    for (let i = 0; i < 300; i++) c.tick(1 / 60);
    expect(c.uniforms().amplitude).toBeLessThan(0.05);
  });
  it("moves much less when reduced motion is requested", () => {
    const normal = new PresenceCore();
    const calm = new PresenceCore({ reducedMotion: true });
    for (const c of [normal, calm]) {
      c.setState("thinking");
      for (let i = 0; i < 300; i++) c.tick(1 / 60);
    }
    expect(calm.uniforms().speed).toBeLessThan(normal.uniforms().speed * 0.4);
    expect(calm.uniforms().rotate).toBeLessThan(normal.uniforms().rotate * 0.4);
  });
});

describe("<Presence>", () => {
  it("renders without WebGL (jsdom) using the fallback and exposes its mode", () => {
    const { container, rerender } = render(<Presence state="idle" amplitude={0} mode="full" />);
    const el = container.querySelector("[data-presence]") as HTMLElement;
    expect(el.dataset.mode).toBe("full");
    rerender(<Presence state="speaking" amplitude={0.7} mode="corner" />);
    expect((container.querySelector("[data-presence]") as HTMLElement).dataset.mode).toBe("corner");
  });
});
