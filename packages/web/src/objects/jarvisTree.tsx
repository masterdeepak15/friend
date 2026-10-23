import * as J from "@masterdeepak15/jarvis-ui";
import "@masterdeepak15/jarvis-ui/styles";
import { JARVIS_COMPONENTS, type JarvisNode } from "@friend/protocol";
import type { ReactNode } from "react";

const clampN = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** What a component gets when the assistant does not say: sizes that sit well beside a stat card in a row. */
const DEFAULTS: Record<string, Record<string, unknown>> = { JGaugeChart: { size: "190px" } };

/** Draws one node of a checked tree. Only components in the allow-list are ever looked up, and only their listed props are passed. */
function draw(n: JarvisNode | string, key: number): ReactNode {
  if (typeof n === "string") return n;
  const kids = (n.kids ?? []).map((k, i) => draw(k, i));
  const slots = Object.fromEntries(Object.entries(n.slots ?? {}).map(([name, parts]) => [name, parts.map((k, i) => draw(k, i))])); // a card's header, a frame's top
  const gap = clampN(n.p?.gap, 0, 32, 8);
  if (n.c === "Row") return <div key={key} className="jv-row" style={{ gap, flexWrap: n.p?.wrap === true ? "wrap" : "nowrap" }}>{kids}</div>;
  if (n.c === "Column") return <div key={key} className="jv-col" style={{ gap }}>{kids}</div>;
  if (n.c === "Grid") return <div key={key} className="jv-grid" style={{ gap, gridTemplateColumns: `repeat(${clampN(n.p?.columns, 1, 6, 2)}, minmax(0, 1fr))` }}>{kids}</div>;
  const Comp = (JARVIS_COMPONENTS[n.c] ? (J as unknown as Record<string, unknown>)[n.c] : undefined) as ((props: Record<string, unknown>) => ReactNode) | undefined;
  if (!Comp) return null;
  return <Comp key={key} {...(DEFAULTS[n.c] ?? {})} {...(n.p ?? {})} {...slots}>{kids.length ? kids : undefined}</Comp>;
}

/** The checked tree, drawn. */
export default function JarvisTree({ node }: { node: JarvisNode }) {
  return <>{draw(node, 0)}</>;
}