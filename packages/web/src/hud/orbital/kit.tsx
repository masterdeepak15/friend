import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/** The animation kit of the orbital HUD: presentational shapes, no data of their own. Motion lives in orbital.css. */

export type Tone = "cyan" | "green" | "orange";
export const clamp = (n: number, lo = 0, hi = 100): number => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);

/** Where a shape sits inside the svg it is drawn in (so several can share one drawing, as in the mockup). */
export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}
const at = (p?: Placed) => (p ? { x: p.x, y: p.y, width: p.w, height: p.h } : {});

/** Shared filters and gradients; mounted once by the HUD and referenced by id. */
export function HudDefs() {
  return (
    <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
      <defs>
        <filter id="ob-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="ob-glow2" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <radialGradient id="ob-orbg" cx="50%" cy="45%" r="55%">
          <stop offset="0" stopColor="#cffafe" />
          <stop offset="0.25" stopColor="#22d3ee" />
          <stop offset="0.6" stopColor="#0e7490" />
          <stop offset="1" stopColor="#042f3c" />
        </radialGradient>
        <linearGradient id="ob-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="ob-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#010609" />
          <stop offset="0.15" stopColor="#010609" stopOpacity="0" />
          <stop offset="0.85" stopColor="#010609" stopOpacity="0" />
          <stop offset="1" stopColor="#010609" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export interface FrameProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
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
export function Frame({ variant = "chamfer", tone = "cyan", title, running = false, className = "", style, children, ...rest }: FrameProps) {
  return (
    <section {...rest} className={`ob-frame ob-v-${variant} ${className}`.trim()} data-tone={tone} {...(running ? { "data-running": "" } : {})} style={style}>
      {title && <header className="ob-frame-title">{title}</header>}
      <div className="ob-frame-body">{children}</div>
    </section>
  );
}

const ARC = "M60 170A90 90 0 0 1 240 170"; // the outer semicircle of the mockup's gauge
const ARC_INNER = "M76 170A74 74 0 0 1 224 170";

/** A semicircle gauge (0..100) with an optional thinner purple arc inside it. */
export function ArcGauge({ value, inner, label = "Gauge", tone = "cyan", frame }: { value: number; inner?: number; label?: string; tone?: Tone; frame?: Placed }) {
  const v = Math.round(clamp(value));
  return (
    <svg className={frame ? undefined : "ob-svg"} {...at(frame)} viewBox="0 0 300 190" role="img" aria-label={`${label} ${v}%`} data-value={v} data-tone={tone}>
      <path d={ARC} className="ob-track" strokeWidth="14" pathLength={100} />
      <path d={ARC} className="ob-fill" strokeWidth="14" pathLength={100} strokeDasharray={`${v} 100`} data-arc="outer" />
      {inner !== undefined && (
        <>
          <path d={ARC_INNER} className="ob-track" strokeWidth="6" pathLength={100} />
          <path d={ARC_INNER} className="ob-fill" strokeWidth="6" pathLength={100} strokeDasharray={`${Math.round(clamp(inner))} 100`} stroke="#a78bfa" data-arc="inner" />
        </>
      )}
    </svg>
  );
}

/** Sound bars, each at its own level (0..1) and bouncing in its own time. */
export function Spectrum({ levels, tone = "cyan", frame }: { levels: number[]; tone?: Tone; frame?: Placed }) {
  const w = Math.max(1, levels.length) * 12;
  return (
    <svg className={frame ? undefined : "ob-svg"} {...at(frame)} viewBox={`0 0 ${w} 100`} preserveAspectRatio="none" aria-hidden="true" data-tone={tone}>
      {levels.map((l, i) => (
        <rect key={i} className="ob-eq" x={i * 12} y={0} width={8} height={100} style={{ ["--lv" as string]: Math.max(0.05, clamp(l, 0, 1)), animationDelay: `${-((i * 0.37) % 0.9)}s`, transform: `scaleY(${Math.max(0.05, clamp(l, 0, 1))})` }} />
      ))}
    </svg>
  );
}

const WAVE = "M0 40H40L52 20L66 62L80 8L96 52L108 40H190L202 28L214 48L226 40H300";
/** A pulse line with a bright light running along it. */
export function PulseLine({ tone = "cyan", frame }: { tone?: Tone; frame?: Placed }) {
  return (
    <svg className={frame ? undefined : "ob-svg"} {...at(frame)} viewBox="0 0 300 70" aria-hidden="true" data-tone={tone}>
      <path className="ob-ecg-base" d={WAVE} />
      <path className="ob-ecg" d={WAVE} />
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
  /** Drawn in orange: a source that needs attention. */
  warn?: boolean;
}

/** A radar with a sweeping beam and a blip per source. */
export function Radar({ blips, frame }: { blips: Blip[]; frame?: Placed }) {
  return (
    <svg className={frame ? undefined : "ob-svg"} {...at(frame)} viewBox="-120 -120 240 240" role="img" aria-label={`Devices: ${blips.map((b) => b.label).join(", ") || "none"}`}>
      <g fill="none" stroke="var(--ob-line)">
        <circle r="110" />
        <circle r="73" />
        <circle r="36" />
        <line x1="-110" x2="110" />
        <line y1="-110" y2="110" />
      </g>
      <circle r="110" fill="none" stroke="#67e8f9" strokeWidth="2" strokeDasharray="1 9" />
      <g className="ob-sweep">
        <path d="M0 0L110 0A110 110 0 0 0 95 -55Z" fill="url(#ob-sweep)" />
        <line x2="110" stroke="#67e8f9" strokeWidth="2" />
      </g>
      {blips.map((b) => {
        const a = (b.angle * Math.PI) / 180;
        const x = Math.cos(a) * clamp(b.distance, 0, 1) * 100;
        const y = -Math.sin(a) * clamp(b.distance, 0, 1) * 100;
        return (
          <g key={b.label} data-blip="" {...(b.dim ? { "data-dim": "" } : {})}>
            <circle className={`ob-blip${b.warn ? " ob-blip-warn" : ""}`} cx={x} cy={y} r="5" />
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
const CELL_TONE: Record<TicketStatus, string> = { done: "var(--ob-green)", doing: "var(--ob-cyan)", review: "var(--ob-orange)", todo: "var(--ob-dim)" };
/** Rows of the honeycomb: six cells, then five, then six (as in the mockup). */
const rowLength = (row: number): number => (row % 2 === 0 ? 6 : 5);

/** Hexagon cells coloured by status, laid out like the mockup's honeycomb. */
export function HexCells({ cells, placeholder = false, frame }: { cells: { status: TicketStatus }[]; placeholder?: boolean; frame?: Placed }) {
  // a dim honeycomb that marks where tickets will appear until there are some
  if (placeholder) cells = Array.from({ length: 11 }, () => ({ status: "todo" as const }));
  const placed: { x: number; y: number; status: TicketStatus }[] = [];
  let row = 0;
  let col = 0;
  for (const c of cells) {
    if (col >= rowLength(row)) {
      row++;
      col = 0;
    }
    placed.push({ x: 20 + col * 40 + (row % 2) * 20, y: 20 + row * 35, status: c.status });
    col++;
  }
  const rows = placed.length ? row + 1 : 1;
  return (
    <svg className={frame ? undefined : "ob-svg"} {...at(frame)} viewBox={`0 0 260 ${rows * 35 + 10}`} aria-hidden="true" {...(placeholder ? { "data-placeholder": "" } : {})}>
      {placed.map((p, i) => (
        <polygon key={i} data-status={p.status} points="-20,0 -10,-17.3 10,-17.3 20,0 10,17.3 -10,17.3" transform={`translate(${p.x} ${p.y})`} fill="none" stroke={CELL_TONE[p.status]} strokeWidth="1.6" className={p.status === "review" ? "ob-pulse" : undefined} />
      ))}
    </svg>
  );
}

/** Concentric rings, the first outermost. */
export function Rings({ rings, placeholder = false, frame }: { rings: { value: number; tone?: Tone; label?: string }[]; placeholder?: boolean; frame?: Placed }) {
  // three empty rings that mark where each worker's budget will appear
  if (placeholder) rings = [{ value: 0 }, { value: 0 }, { value: 0 }];
  const named = placeholder ? { "aria-hidden": true as const, "data-placeholder": "" } : { role: "img", "aria-label": rings.map((r) => `${r.label ?? "ring"} ${Math.round(clamp(r.value))}%`).join(", ") || "no data" };
  return (
    <svg className={frame ? undefined : "ob-svg"} {...at(frame)} viewBox="-50 -50 100 100" {...named}>
      {rings.map((r, i) => {
        const radius = 38 - i * 12;
        if (radius <= 2) return null;
        const v = Math.round(clamp(r.value));
        return (
          <g key={i} data-tone={r.tone ?? "cyan"} transform="rotate(-90)">
            <circle r={radius} className="ob-track" strokeWidth="8" />
            <circle r={radius} className="ob-fill" strokeWidth="8" pathLength={100} strokeDasharray={`${v} 100`} data-ring={i} data-value={v} />
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
    <svg className="ob-svg" viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {Array.from({ length: segments }, (_, i) => {
        const a = ((-90 + (i * 360) / segments) * Math.PI) / 180;
        const [r1, r2] = [radius - 7, radius + 7];
        return <line key={i} className="ob-seg" data-seg="" data-on={i < lit ? "true" : "false"} x1={c + r1 * Math.cos(a)} y1={c + r1 * Math.sin(a)} x2={c + r2 * Math.cos(a)} y2={c + r2 * Math.sin(a)} />;
      })}
    </svg>
  );
}

export type NodeStatus = "running" | "waiting" | "idle" | "add";
const NODE_TONE: Record<NodeStatus, Tone> = { running: "green", waiting: "orange", idle: "cyan", add: "cyan" };

export interface HexNodeProps {
  label: string;
  /** What is drawn inside the hexagon (a symbol); defaults to the start of the label. */
  glyph?: string;
  /** A short name written under the hexagon. */
  caption?: string;
  detail?: string;
  status?: NodeStatus;
  onClick?: () => void;
  /** A position in pixels; the node is centred on it. Omit to place it yourself. */
  x?: number;
  y?: number;
}

/** A node of the orbit: a hexagon you can click. */
export function HexNode({ label, glyph, caption, detail, status = "idle", onClick, x, y }: HexNodeProps) {
  const placed: CSSProperties | undefined = x !== undefined && y !== undefined ? { left: x, top: y } : undefined;
  return (
    <button type="button" className="ob-node" data-tone={NODE_TONE[status]} data-status={status} aria-label={detail ? `${label}, ${detail}` : label} title={label} style={placed} onClick={onClick}>
      <svg viewBox="-34 -30 68 60" aria-hidden="true">
        <polygon points="-34,0 -17,-29.4 17,-29.4 34,0 17,29.4 -17,29.4" />
        <text className={`ob-node-label${glyph ? " ob-glyph" : ""}`}>{glyph ?? (label.length > 6 ? `${label.slice(0, 5)}…` : label)}</text>
      </svg>
      {caption && <span className="ob-node-caption">{caption}</span>}
    </button>
  );
}

/** A line between two points inside an svg; data runs along it unless `flowing` is off. */
export function LinkLine({ x1, y1, x2, y2, tone = "cyan", flowing = true }: { x1: number; y1: number; x2: number; y2: number; tone?: Tone; flowing?: boolean }) {
  return <line className={`ob-link${flowing ? " ob-flow" : ""}`} data-tone={tone} x1={x1} y1={y1} x2={x2} y2={y2} />;
}