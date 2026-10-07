import { useId } from "react";
import { arcPath, circleLayout, gaugeAngle, linePath, niceScale, scaleLinear } from "./geometry";

type Props = Record<string, unknown>;

const isObj = (v: unknown): v is Props => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const PALETTE = ["var(--accent)", "#ffb454", "#7b8cff", "#5ef0b0", "#ff6b7a", "#c792ea"];

const Title = ({ text }: { text: string }) => (text ? <h3 className="obj-title">{text}</h3> : null);
const Empty = ({ text = "No data" }: { text?: string }) => <p className="obj-empty">{text}</p>;

// ---------------------------------------------------------------- chart

const W = 400;
const H = 220;
const M = { l: 44, r: 12, t: 10, b: 28 };

export function Chart({ props }: { props: Props }) {
  const kind = props.kind === "bar" || props.kind === "area" ? props.kind : "line";
  const labels = arr(props.labels).slice(0, 120).map(str);
  const series = arr(props.series)
    .slice(0, 6)
    .map((s, i) => {
      const o = isObj(s) ? s : {};
      const points = arr(o.values)
        .slice(0, 120)
        .map((v, idx) => ({ idx, v: num(v) }))
        .filter((p): p is { idx: number; v: number } => p.v !== null);
      return { name: str(o.name) || `series ${i + 1}`, points };
    })
    .filter((s) => s.points.length > 0);

  if (series.length === 0) return (<><Title text={str(props.title)} /><Empty /></>);

  const all = series.flatMap((s) => s.points.map((p) => p.v));
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = niceScale(kind === "line" ? lo : Math.min(0, lo), kind === "line" ? hi : Math.max(0, hi), 5);
  const n = Math.max(labels.length, ...series.map((s) => s.points[s.points.length - 1]!.idx + 1), 2);
  const sy = scaleLinear([y.min, y.max], [H - M.b, M.t]);
  const sx = scaleLinear([0, n - 1], [M.l, W - M.r]);
  const band = (W - M.l - M.r) / n;
  const barW = Math.max(1, (band * 0.7) / series.length);
  const bx = (idx: number, si: number) => M.l + idx * band + band * 0.15 + si * barW;
  const labelStep = Math.max(1, Math.ceil(n / 6));
  const unit = str(props.unit);

  return (
    <>
      <Title text={str(props.title)} />
      <svg className="obj-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={str(props.title) || "chart"}>
        {y.ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={M.l} x2={W - M.r} y1={sy(t)} y2={sy(t)} />
            <text className="tick" x={M.l - 6} y={sy(t) + 3} textAnchor="end">
              {t}
              {unit && t === y.max ? unit : ""}
            </text>
          </g>
        ))}
        {Array.from({ length: n }, (_, i) => i)
          .filter((i) => i % labelStep === 0 && labels[i])
          .map((i) => (
            <text key={i} className="tick" x={kind === "bar" ? bx(i, 0) + (barW * series.length) / 2 : sx(i)} y={H - 8} textAnchor="middle">
              {clip(labels[i]!, 8)}
            </text>
          ))}
        {series.map((s, si) => {
          const color = PALETTE[si % PALETTE.length]!;
          if (kind === "bar") {
            return (
              <g key={si}>
                {s.points.map((p) => (
                  <rect key={p.idx} className="bar" x={bx(p.idx, si)} y={Math.min(sy(p.v), sy(0))} width={barW} height={Math.abs(sy(p.v) - sy(0))} fill={color} />
                ))}
              </g>
            );
          }
          const pts = s.points.map((p): [number, number] => [sx(p.idx), sy(p.v)]);
          const d = linePath(pts);
          const area = `${d} L${pts[pts.length - 1]![0].toFixed(2)} ${sy(y.min).toFixed(2)} L${pts[0]![0].toFixed(2)} ${sy(y.min).toFixed(2)} Z`;
          return (
            <g key={si}>
              {kind === "area" && <path className="series-area" d={area} fill={color} opacity={0.18} />}
              <path className="series-line" d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <ul className="legend">
          {series.map((s, si) => (
            <li key={si}>
              <i style={{ background: PALETTE[si % PALETTE.length] }} />
              <span>{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- gauge

export function Gauge({ props }: { props: Props }) {
  const min = num(props.min) ?? 0;
  const max = num(props.max) ?? 100;
  const value = num(props.value) ?? min;
  const angle = gaugeAngle(value, min, max);
  const frac = angle / 240;
  const level = frac > 0.95 ? "gauge-crit" : frac > 0.8 ? "gauge-warn" : "";
  return (
    <div className={`obj-gauge ${level}`}>
      <svg viewBox="0 0 200 150" role="img" aria-label={`${str(props.label)} ${value}`}>
        <path className="track" d={arcPath(100, 100, 70, 150, 390)} fill="none" strokeWidth={12} strokeLinecap="round" />
        {angle > 0 && <path className="value" d={arcPath(100, 100, 70, 150, 150 + angle)} fill="none" strokeWidth={12} strokeLinecap="round" />}
      </svg>
      <div className="gauge-read">
        <span className="gauge-value">{String(Math.round(value * 100) / 100)}</span>
        {str(props.unit) && <small className="gauge-unit">{str(props.unit)}</small>}
      </div>
      <span className="obj-label">{str(props.label)}</span>
    </div>
  );
}

// ------------------------------------------------------------- timeline

export function Timeline({ props }: { props: Props }) {
  const items = arr(props.items)
    .slice(0, 30)
    .map((it) => (isObj(it) ? it : {}))
    .map((o) => ({ time: str(o.time), title: str(o.title), detail: str(o.detail) }))
    .filter((it) => it.title || it.time);
  if (items.length === 0) return (<><Title text={str(props.title)} /><Empty text="Nothing to show" /></>);
  return (
    <>
      <Title text={str(props.title)} />
      <ol className="obj-timeline">
        {items.map((it, i) => (
          <li key={i}>
            <time>{it.time}</time>
            <strong>{it.title}</strong>
            {it.detail && <span>{it.detail}</span>}
          </li>
        ))}
      </ol>
    </>
  );
}

// ---------------------------------------------------------------- graph

const GW = 400;
const GH = 300;

export function Graph({ props }: { props: Props }) {
  const markerId = useId();
  const seen = new Set<string>();
  const nodes: { id: string; label: string }[] = [];
  for (const n of arr(props.nodes)) {
    const o = isObj(n) ? n : {};
    const id = str(o.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: str(o.label) || id });
    if (nodes.length >= 40) break;
  }
  if (nodes.length === 0) return (<><Title text={str(props.title)} /><Empty text="Nothing to show" /></>);

  const pos = new Map(nodes.map((n, i) => [n.id, circleLayout(nodes.length, GW, GH)[i]!] as const));
  const edges: { from: string; to: string; label: string }[] = [];
  for (const e of arr(props.edges)) {
    const o = isObj(e) ? e : {};
    const from = str(o.from);
    const to = str(o.to);
    if (!pos.has(from) || !pos.has(to) || from === to) continue;
    edges.push({ from, to, label: str(o.label) });
    if (edges.length >= 80) break;
  }

  return (
    <>
      <Title text={str(props.title)} />
      <svg className="obj-graph" viewBox={`0 0 ${GW} ${GH}`} role="img" aria-label={str(props.title) || "graph"}>
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="arrow" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const cx = (a.x + b.x) / 2 + (GW / 2 - (a.x + b.x) / 2) * 0.25;
          const cy = (a.y + b.y) / 2 + (GH / 2 - (a.y + b.y) / 2) * 0.25;
          return (
            <g key={i}>
              <path className="edge" d={`M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`} fill="none" markerEnd={`url(#${markerId})`} />
              {e.label && (
                <text className="edge-label" x={cx} y={cy} textAnchor="middle">
                  {clip(e.label, 12)}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <circle className="node" cx={p.x} cy={p.y} r={12} />
              <text className="node-label" x={p.x} y={p.y + 26} textAnchor="middle">
                {clip(n.label, 18)}
              </text>
            </g>
          );
        })}
      </svg>
    </>
  );
}
