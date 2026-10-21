import { Rings } from "../kit";

/** One ring per worker with a list beside it. With no workers yet it is three dim rings that say so. */
export function BudgetWidget({ rings = [] }: { rings?: { label: string; value: number; text?: string }[] }) {
  const empty = rings.length === 0;
  return (
    <svg className="ob-wsvg" viewBox="0 0 270 110">
      <Rings rings={rings.map((r, i) => ({ value: r.value, label: r.label, tone: (["cyan", "cyan", "green"] as const)[i] ?? "cyan" }))} placeholder={empty} frame={{ x: -10, y: -10, w: 100, h: 100 }} />
      <text className="ob-lab" x="104" y="26">BUDGET</text>
      {empty ? (
        <text className="ob-sm" x="104" y="46">No workers yet</text>
      ) : (
        rings.slice(0, 3).map((r, i) => (
          <text key={r.label} className="ob-sm" x="104" y={46 + i * 18}>{r.label} {r.text ?? `${Math.round(r.value)}%`}</text>
        ))
      )}
    </svg>
  );
}