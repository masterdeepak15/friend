import type { CSSProperties, ReactNode } from "react";

/** The animation kit of the orbital HUD: presentational shapes, no data of their own. Motion lives in orbital.css. */

export type Tone = "cyan" | "green" | "orange";
export const clamp = (n: number, lo = 0, hi = 100): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Shared filters and gradients; mounted once by the HUD and referenced by id. */
export function HudDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        <filter id="hud-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="hud-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.7" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export interface FrameProps {
  variant?: "chamfer" | "bracket" | "octagon" | "slant";
  tone?: Tone;
  title?: string;
  /** A light runs round the border. */
  running?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** The border shape of an instrument, with an optional title tab and running light. */
export function Frame({ variant = "chamfer", tone = "cyan", title, running = false, className = "", style, children }: FrameProps) {
  return (
    <section className={`hud-frame hud-v-${variant} ${className}`.trim()} data-tone={tone} {...(running ? { "data-running": "" } : {})} style={style}>
      {title && <header className="hud-frame-title">{title}</header>}
      <div className="hud-frame-body">{children}</div>
    </section>
  );
}

const ARC = "M20 170A130 130 0 0 1 280 170"; // the outer semicircle
const ARC_INNER = "M44 170A106 106 0 0 1 256 170";

/** A semicircle gauge (0..100) with an optional thinner arc inside it. */
export function ArcGauge({ value, inner, label = "Gauge", tone = "cyan" }: { value: number; inner?: number; label?: string; tone?: Tone }) {
  const v = Math.round(clamp(value));
  return (
    <svg className="hud-svg" viewBox="0 0 300 190" role="img" aria-label={`${label} ${v}%`} data-value={v} data-tone={tone}>
      <path d={ARC} className="hud-track" strokeWidth="14" pathLength={100} />
      <path d={ARC} className="hud-fill" strokeWidth="14" pathLength={100} strokeDasharray={`${v} 100`} data-arc="outer" />
      {inner !== undefined && (
        <>
          <path d={ARC_INNER} className="hud-track" strokeWidth="6" pathLength={100} />
          <path d={ARC_INNER} className="hud-fill" strokeWidth="6" pathLength={100} strokeDasharray={`${Math.round(clamp(inner))} 100`} stroke="#a78bfa" data-arc="inner" />
        </>
      )}
    </svg>
  );
}

/** Sound bars, each at its own level (0..1) and bouncing in its own time. */
export function Spectrum({ levels, tone = "cyan" }: { levels: number[]; tone?: Tone }) {
  const w = Math.max(1, levels.length) * 12;
  return (
    <svg className="hud-svg" viewBox={`0 0 ${w} 100`} aria-hidden="true" data-tone={tone}>
      {levels.map((l, i) => (
        <rect key={i} className="hud-eq" x={i * 12} y={0} width={8} height={100} style={{ ["--lv" as string]: Math.max(0.05, clamp(l, 0, 1)), animationDelay: `${-((i * 0.37) % 0.9)}s`, transform: `scaleY(${Math.max(0.05, clamp(l, 0, 1))})` }} />
      ))}
    </svg>
  );
}

const WAVE = "M0 40H40L52 20L66 62L80 8L96 52L108 40H190L202 28L214 48L226 40H300";
/** A pulse line with a bright light running along it. */
export function PulseLine({ tone = "cyan" }: { tone?: Tone }) {
  return (
    <svg className="hud-svg" viewBox="0 0 300 70" aria-hidden="true" data-tone={tone}>
      <path className="hud-ecg-base" d={WAVE} />
      <path className="hud-ecg" d={WAVE} />
    </svg>
  );
}

export interface Blip {
  /** Degrees, 0 to the right, counter-clockwise. */
  angle: number;
  /** 0 (centre) to 1 (edge). */
  distance: number;
  label: string;
  dim?: boolean;
}

/** A radar with a sweeping beam and a blip per source. */
export function Radar({ blips }: { blips: Blip[] }) {
  return (
    <svg className="hud-svg" viewBox="-120 -120 240 240" role="img" aria-label={`Devices: ${blips.map((b) => b.label).join(", ") || "none"}`}>
      <g fill="none" stroke="var(--hud-line)">
        <circle r="110" />
        <circle r="73" />
        <circle r="36" />
        <line x1="-110" x2="110" />
        <line y1="-110" y2="110" />
      </g>
      <g className="hud-sweep">
        <path d="M0 0L110 0A110 110 0 0 0 95 -55Z" fill="url(#hud-sweep)" />
        <line x2="110" stroke="#67e8f9" strokeWidth="2" />
      </g>
      {blips.map((b) => {
        const a = (b.angle * Math.PI) / 180;
        const x = Math.cos(a) * clamp(b.distance, 0, 1) * 100;
        const y = -Math.sin(a) * clamp(b.distance, 0, 1) * 100;
        return (
          <g key={b.label} data-blip="" {...(b.dim ? { "data-dim": "" } : {})}>
            <circle className="hud-blip" cx={x} cy={y} r="5" />
            <text x={x + 9} y={y + 4} fontSize="11" fill="currentColor" opacity={b.dim ? 0.5 : 1}>
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export type TicketStatus = "done" | "doing" | "review" | "todo";
const CELL_TONE: Record<TicketStatus, string> = { done: "var(--hud-green)", doing: "var(--hud-cyan)", review: "var(--hud-orange)", todo: "var(--hud-dim)" };

/** Hexagon cells coloured by status, laid out like a honeycomb. */
export function HexCells({ cells }: { cells: { status: TicketStatus }[] }) {
  const cols = 5;
  const rows = Math.max(1, Math.ceil(cells.length / cols));
  return (
    <svg className="hud-svg" viewBox={`0 0 ${cols * 40 + 20} ${rows * 35 + 10}`} aria-hidden="true">
      {cells.map((c, i) => {
        const row = Math.floor(i / cols);
        const x = (i % cols) * 40 + 20 + (row % 2) * 20;
        const y = row * 35 + 20;
        return <polygon key={i} data-status={c.status} points="-20,0 -10,-17.3 10,-17.3 20,0 10,17.3 -10,17.3" transform={`translate(${x} ${y})`} fill="none" stroke={CELL_TONE[c.status]} strokeWidth="1.6" className={c.status === "review" ? "hud-blip" : undefined} />;
      })}
    </svg>
  );
}

/** Concentric rings, the first outermost. */
export function Rings({ rings }: { rings: { value: number; tone?: Tone; label?: string }[] }) {
  return (
    <svg className="hud-svg" viewBox="-50 -50 100 100" role="img" aria-label={rings.map((r) => `${r.label ?? "ring"} ${Math.round(clamp(r.value))}%`).join(", ") || "no data"}>
      {rings.map((r, i) => {
        const radius = 38 - i * 12;
        if (radius <= 2) return null;
        const v = Math.round(clamp(r.value));
        return (
          <g key={i} data-tone={r.tone ?? "cyan"} transform="rotate(-90)">
            <circle r={radius} className="hud-track" strokeWidth="8" />
            <circle r={radius} className="hud-fill" strokeWidth="8" pathLength={100} strokeDasharray={`${v} 100`} data-ring={i} data-value={v} />
          </g>
        );
      })}
    </svg>
  );
}

/** A ring of short bars; the first `value` percent are lit. This is the usage ring around the orb. */
export function SegmentedRing({ value, segments = 60, radius = 205, size = 460 }: { value: number; segments?: number; radius?: number; size?: number }) {
  const lit = Math.round((segments * clamp(value)) / 100);
  const c = size / 2;
  return (
    <svg className="hud-svg" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {Array.from({ length: segments }, (_, i) => {
        const a = ((-90 + (i * 360) / segments) * Math.PI) / 180;
        const [r1, r2] = [radius - 7, radius + 7];
        return <line key={i} className="hud-seg" data-seg="" data-on={i < lit ? "true" : "false"} x1={c + r1 * Math.cos(a)} y1={c + r1 * Math.sin(a)} x2={c + r2 * Math.cos(a)} y2={c + r2 * Math.sin(a)} />;
      })}
    </svg>
  );
}

export type NodeStatus = "running" | "waiting" | "idle" | "add";
const NODE_TONE: Record<NodeStatus, Tone> = { running: "green", waiting: "orange", idle: "cyan", add: "cyan" };

export interface HexNodeProps {
  label: string;
  detail?: string;
  status?: NodeStatus;
  onClick?: () => void;
  /** A position in pixels; the node is centred on it. Omit to place it yourself. */
  x?: number;
  y?: number;
}

/** A node of the orbit: a hexagon you can click. */
export function HexNode({ label, detail, status = "idle", onClick, x, y }: HexNodeProps) {
  const placed: CSSProperties | undefined = x !== undefined && y !== undefined ? { left: x, top: y } : undefined;
  return (
    <button type="button" className="hud-node" data-tone={NODE_TONE[status]} data-status={status} aria-label={detail ? `${label}, ${detail}` : label} style={placed} onClick={onClick}>
      <svg viewBox="-34 -30 68 60" aria-hidden="true">
        <polygon points="-34,0 -17,-29.4 17,-29.4 34,0 17,29.4 -17,29.4" />
        <text className="hud-node-label">{label.length > 6 ? `${label.slice(0, 5)}…` : label}</text>
      </svg>
    </button>
  );
}

/** A line between two points inside an svg; data runs along it unless `flowing` is off. */
export function LinkLine({ x1, y1, x2, y2, tone = "cyan", flowing = true }: { x1: number; y1: number; x2: number; y2: number; tone?: Tone; flowing?: boolean }) {
  return <line className={`hud-link${flowing ? " hud-flow" : ""}`} data-tone={tone} x1={x1} y1={y1} x2={x2} y2={y2} />;
}
