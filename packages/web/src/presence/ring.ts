import type { PresenceState } from "@friend/protocol";
import { PresenceCore, type PresenceHandle, type PresenceMode } from "./core";

const safe = (n: number) => (Number.isFinite(n) ? n : 0);

/** Bar heights (0..1) around the ring: a slow base wave plus an amplitude-driven shimmer. */
export function ringBars(count: number, phase: number, amplitude: number, noise: number): number[] {
  const p = safe(phase);
  const a = Math.min(1, Math.max(0, safe(amplitude)));
  const n = Math.min(1, Math.max(0, safe(noise)));
  return Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => {
    const base = 0.12 + 0.18 * (0.5 + 0.5 * Math.sin(i * 0.31 + p * 2.2)) + n * (0.5 + 0.5 * Math.sin(i * 0.9 + p * 4));
    const shimmer = a * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(i * 2.1 + p * 9)));
    return Math.min(1, Math.max(0, base + shimmer));
  });
}

const BARS = 96;

/** Radial-bar voice ring drawn on a 2D canvas (no WebGL needed). */
export class RingPresence implements PresenceHandle {
  private core: PresenceCore;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null;
  private raf = 0;
  private last = 0;
  private ro: ResizeObserver | null = null;
  private disposed = false;
  private accent: string;

  constructor(private host: HTMLElement, accent: string, reducedMotion: boolean) {
    this.core = new PresenceCore({ reducedMotion });
    this.accent = accent;
    this.canvas.style.cssText = "width:100%;height:100%;display:block";
    this.ctx = this.canvas.getContext("2d");
    host.appendChild(this.canvas);
    if (!this.ctx) return;
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
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
    const size = Math.min(w, h);
    ctx.clearRect(0, 0, w, h);
    const radius = size * 0.27 * (1 - u.tighten);
    const maxLen = size * 0.2;
    const bars = ringBars(BARS, u.phase, u.amplitude, u.noise);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(u.angle);
    ctx.lineCap = "round";
    ctx.strokeStyle = this.accent;
    ctx.shadowColor = this.accent;
    ctx.shadowBlur = size * 0.02 * u.brightness;
    ctx.lineWidth = Math.max(2, size * 0.008);
    const thinking = this.core.state === "thinking";
    for (let i = 0; i < BARS; i++) {
      const a = (i / BARS) * Math.PI * 2;
      // while thinking, a comet-like gap travels around the ring
      const gap = thinking ? 0.25 + 0.75 * Math.abs(Math.sin((a - u.phase * 2) / 2)) : 1;
      ctx.globalAlpha = Math.min(1, (0.35 + bars[i]! * 0.65) * u.brightness * gap);
      const len = size * 0.012 + bars[i]! * maxLen;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.lineTo(Math.cos(a) * (radius + len), Math.sin(a) * (radius + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 0.28 * u.brightness;
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1, size * 0.003);
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
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
