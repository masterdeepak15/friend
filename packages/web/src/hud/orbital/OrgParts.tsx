import { JCard, JDataRow, JNodeGraph, JStatusPill, type EdgeDef, type NodeDef } from "@masterdeepak15/jarvis-ui";
import "@masterdeepak15/jarvis-ui/styles";
import type { OfficeWorkerView } from "@friend/protocol";
import { ORG_CARD_H, ORG_CARD_W, ORG_GAP_X, ORG_GAP_Y, layoutOrg } from "./office";

type Color = NodeDef["color"];
const COLOR: Record<OfficeWorkerView["status"], Color> = { starting: "green", running: "green", waiting: "amber", idle: "cyan", paused: "ghost", stopped: "ghost", failed: "red" };
const PILL: Record<OfficeWorkerView["status"], "active" | "warning" | "error" | "success"> = { starting: "active", running: "active", waiting: "warning", idle: "success", paused: "warning", stopped: "warning", failed: "error" };

const NODE_W = 150; // about how wide the library draws a node, and its height
const NODE_H = 60;
const MARGIN = 24;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/**
 * The Office as a graph drawn with the Jarvis library, filling the room it is given: the assistant on the left, the people who report to it to
 * the right, spread over the whole width and height (the library draws its lines from the right of one node to the left of the next).
 */
export function OrgGraph({ workers, name, width, height }: { workers: OfficeWorkerView[]; name: string; width: number; height: number }) {
  const layout = layoutOrg(workers);
  const zoom = Math.max(1.25, Math.min(1.9, width / 520)); // the library draws its nodes small, so they are enlarged to suit the room
  const w = Math.floor(width / zoom);
  const h = Math.floor(height / zoom);
  const depth = (n: { y: number }) => Math.round(n.y / (ORG_CARD_H + ORG_GAP_Y));
  const row = (n: { x: number }) => n.x / (ORG_CARD_W + ORG_GAP_X);
  const maxDepth = Math.max(0, ...layout.nodes.map(depth));
  const maxRow = Math.max(0, ...layout.nodes.map(row));
  const at = (n: { x: number; y: number }) => ({
    x: Math.round(maxDepth === 0 ? (w - NODE_W) / 2 : MARGIN + (depth(n) / maxDepth) * (w - 2 * MARGIN - NODE_W)),
    y: Math.round(maxRow === 0 ? (h - NODE_H) / 2 : MARGIN + (row(n) / maxRow) * (h - 2 * MARGIN - NODE_H)),
  });
  const nodes: NodeDef[] = layout.nodes.map((n) => {
    const spot = at(n);
    return n.worker
      ? { id: n.id, label: clip(n.worker.name.toUpperCase(), 14), sub: clip(n.worker.title, 15), value: clip(n.worker.detail || n.worker.status, 14), ...spot, color: COLOR[n.worker.status], pulse: n.worker.status === "running" || n.worker.status === "starting" || n.worker.status === "waiting" }
      : { id: n.id, label: clip(name.toUpperCase(), 12), sub: "assistant", ...spot, type: "hub" as const, color: "cyan" as const };
  });
  const status = new Map(workers.map((x) => [x.id, x.status] as const));
  const edges: EdgeDef[] = layout.edges.map((e) => ({ from: e.from, to: e.to, arrow: true, animated: status.get(e.to) === "running" || status.get(e.to) === "starting", color: status.get(e.to) === "waiting" ? "amber" : "cyan" }));
  return (
    <div style={{ zoom }} className="ob-org-zoom">
      <JNodeGraph nodes={nodes} edges={edges} width={`${w}px`} height={`${h}px`} showLegend={false} />
    </div>
  );
}

/** One card for each worker, drawn with the Jarvis card and rows: the rows fill the card whatever its width. */
export function OrgRoster({ workers, name, onWorker }: { workers: OfficeWorkerView[]; name: string; onWorker: (id: string) => void }) {
  const byId = new Map(workers.map((x) => [x.id, x] as const));
  return (
    <div className="ob-roster">
      {workers.map((x) => {
        const share = x.budget && x.budget > 0 ? Math.min(100, (100 * x.tokens) / x.budget) : undefined;
        return (
          <div key={x.id} role="button" tabIndex={0} className="ob-roster-item" data-status={x.status === "starting" ? "running" : x.status === "paused" || x.status === "stopped" ? "idle" : x.status} aria-label={`${x.name}, ${x.title}, ${x.detail || x.status}`} onClick={() => onWorker(x.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onWorker(x.id))}>
            <JCard
              color={COLOR[x.status]}
              header={
                <div className="ob-roster-head">
                  <b>{x.name}</b>
                  <JStatusPill state={PILL[x.status]}>{x.status.toUpperCase()}</JStatusPill>
                </div>
              }
            >
              <JDataRow label="JOB" value={x.title} />
              <JDataRow label="DOING" value={x.detail || x.status} />
              <JDataRow label="REPORTS TO" value={(x.managerId && byId.get(x.managerId)?.name) || name} />
              <JDataRow label="TOKENS" value={short(x.tokens)} {...(share !== undefined ? { barPercent: share } : {})} />
            </JCard>
          </div>
        );
      })}
    </div>
  );
}