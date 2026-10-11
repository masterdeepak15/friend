import { useEffect, useRef } from "react";
import { IconNote } from "../hud/icons";

const BARS = 56;

/** What the dial and the level bars share, updated every frame: how loud each part of the sound is (0..1). */
export interface Levels {
  bars: Float32Array;
  bass: number;
  left: number;
  right: number;
}
export const newLevels = (): Levels => ({ bars: new Float32Array(BARS), bass: 0, left: 0, right: 0 });

/** Reads the analyser into `levels`. With no analyser (or when paused) the sound falls away smoothly; while playing without one, a gentle motion stands in. */
export function readLevels(levels: Levels, analyser: AnalyserNode | null, playing: boolean, now: number, data: Uint8Array<ArrayBuffer>): void {
  const fall = playing ? 0.82 : 0.9;
  if (analyser && playing) {
    analyser.getByteFrequencyData(data);
    const usable = Math.min(data.length, 96);
    for (let i = 0; i < BARS; i++) {
      // low sounds are spread over more bars than high ones, like an ear hears them
      const at = Math.min(usable - 1, Math.floor(Math.pow(i / BARS, 1.6) * usable));
      levels.bars[i] = Math.max((data[at] ?? 0) / 255, levels.bars[i]! * fall);
    }
  } else if (playing) {
    for (let i = 0; i < BARS; i++) levels.bars[i] = Math.max(0.12 + 0.28 * Math.abs(Math.sin(now / 420 + i * 0.55) * Math.cos(now / 900 + i * 0.21)), levels.bars[i]! * fall);
  } else {
    for (let i = 0; i < BARS; i++) levels.bars[i] = levels.bars[i]! * fall;
  }
  let low = 0;
  for (let i = 0; i < 6; i++) low += levels.bars[i]!;
  levels.bass = Math.min(1, (low / 6) * 1.15);
  let l = 0;
  let r = 0;
  for (let i = 0; i < BARS / 2; i++) {
    l += levels.bars[i]!;
    r += levels.bars[i + BARS / 2]!;
  }
  levels.left = Math.min(1, (l / (BARS / 2)) * 1.6);
  levels.right = Math.min(1, (r / (BARS / 2)) * 3.2);
}

interface DialProps {
  /** 0..1 of the track played. */
  progress: number;
  playing: boolean;
  /** A picture for the middle, or null for the emblem. */
  cover: string | null;
  analyser: AnalyserNode | null;
  levels: Levels;
  /** Draw the moving bars. */
  visualizer: boolean;
  /** Keep the animation frames going (false when animations are off). */
  animate: boolean;
  size: number;
}

/**
 * The round display of the player: a ring that fills as the track plays, a needle that sweeps while it plays, the cover in the
 * middle (turning slowly, pulsing with the bass) and bars around it that follow the sound.
 */
export function Dial({ progress, playing, cover, analyser, levels, visualizer, animate, size }: DialProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const data = useRef(new Uint8Array(new ArrayBuffer(128)));

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx || !animate) return;
    let raf = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(size * dpr);
    const accent = getComputedStyle(c).getPropertyValue("--accent").trim() || "#3fd8ff";
    const draw = (now: number) => {
      readLevels(levels, analyser, playing, now, data.current);
      root.current?.style.setProperty("--bass", levels.bass.toFixed(3));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      if (visualizer) {
        const cx = size / 2;
        const inner = size * 0.335;
        const reach = size * 0.135;
        ctx.lineCap = "round";
        ctx.lineWidth = Math.max(1.5, size / 90);
        for (let i = 0; i < BARS; i++) {
          const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
          const v = levels.bars[i]!;
          const len = 2 + v * reach;
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.35 + v * 0.65;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * inner, cx + Math.sin(a) * inner);
          ctx.lineTo(cx + Math.cos(a) * (inner + len), cx + Math.sin(a) * (inner + len));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      const settled = !playing && levels.bars.every((b) => b < 0.01);
      if (!settled || visualizer) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [analyser, playing, visualizer, animate, size, levels]);

  const pct = Math.max(0, Math.min(1, progress)) * 100;
  return (
    <div ref={root} className={`hud-dial${playing ? " playing" : ""}`} style={{ width: size, height: size }} role="img" aria-label="Playback dial">
      <svg className="hud-dial-svg" viewBox="0 0 200 200" aria-hidden="true">
        <circle className="hud-dial-ticks" cx="100" cy="100" r="96" />
        <circle className="hud-dial-track" cx="100" cy="100" r="88" />
        <circle className="hud-dial-arc" cx="100" cy="100" r="88" pathLength="100" strokeDasharray={`${pct} 100`} transform="rotate(-90 100 100)" />
        <circle className="hud-dial-inner" cx="100" cy="100" r="62" />
        <g className="hud-needle">
          <line x1="100" y1="100" x2="100" y2="14" />
          <circle cx="100" cy="14" r="2.500" />
        </g>
      </svg>
      <canvas ref={canvas} className="hud-spectrum" style={{ width: size, height: size }} aria-hidden="true" />
      <div className="hud-cover" style={cover ? { backgroundImage: `url("${cover}")` } : undefined}>
        {!cover && <IconNote />}
      </div>
    </div>
  );
}
