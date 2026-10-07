import type { PresenceState } from "@friend/protocol";
import { PresenceCore, type PresenceHandle, type PresenceMode } from "./core";
import { fibonacciSphere } from "./sphere";

/** Canvas 2D particle sphere used when WebGL is unavailable. */
export class Fallback2D implements PresenceHandle {
  private core: PresenceCore;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null;
  private pts: Float32Array;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver | null = null;
  private disposed = false;
  private accent: string;

  constructor(private host: HTMLElement, count: number, accent: string, reducedMotion: boolean) {
    this.core = new PresenceCore({ reducedMotion });
    this.accent = accent;
    this.pts = fibonacciSphere(Math.min(Math.max(count, 600), 1400));
    this.canvas.style.cssText = "width:100%;height:100%;display:block";
    this.ctx = this.canvas.getContext("2d");
    host.appendChild(this.canvas);
    if (!this.ctx) return; // nothing to draw on (e.g. test environment)
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, this.host.clientWidth) * dpr;
    this.canvas.height = Math.max(1, this.host.clientHeight) * dpr;
  }

  private frame = (t: number): void => {
    if (this.disposed || !this.ctx) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) {
      this.last = t;
      return;
    }
    const dt = this.last ? Math.min((t - this.last) / 1000, 0.1) : 0.016;
    this.last = t;
    this.core.tick(dt);
    const u = this.core.uniforms();
    const { width: w, height: h } = this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.accent;
    const radius = Math.min(w, h) * 0.36 * (1 - u.tighten);
    const c = Math.cos(u.angle);
    const s = Math.sin(u.angle);
    const n = this.pts.length / 3;
    for (let i = 0; i < n; i++) {
      const x0 = this.pts[i * 3]!;
      const y0 = this.pts[i * 3 + 1]!;
      const z0 = this.pts[i * 3 + 2]!;
      const wob = 1 + (Math.sin(u.phase * 3 + i * 0.37) * u.noise + Math.sin(u.phase * 7 + i) * u.amplitude * 0.25);
      const x = (c * x0 + s * z0) * wob;
      const z = (-s * x0 + c * z0) * wob;
      const y = y0 * wob;
      const depth = (z + 1.5) / 3;
      ctx.globalAlpha = Math.min(1, (0.25 + depth * 0.75) * u.brightness);
      const size = (0.8 + depth) * u.size * (w / 700 + 0.6);
      ctx.fillRect(w / 2 + x * radius, h / 2 + y * radius, size, size);
    }
    ctx.globalAlpha = 1;
  };

  setState(s: PresenceState): void {
    this.core.setState(s);
  }
  setAmplitude(v: number): void {
    this.core.setAmplitude(v);
  }
  setMode(_m: PresenceMode): void {
    this.resize();
  }
  setAccent(color: string): void {
    this.accent = color;
  }
  setIntensity(v: number): void {
    this.core.setIntensity(v);
  }
  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.canvas.remove();
  }
}
