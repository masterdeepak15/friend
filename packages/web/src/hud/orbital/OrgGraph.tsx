import { JNodeGraph, type EdgeDef, type NodeDef } from "@masterdeepak15/jarvis-ui";
import "@masterdeepak15/jarvis-ui/styles";
import type { OfficeWorkerView } from "@friend/protocol";
import { ORG_CARD_H, ORG_CARD_W, ORG_GAP_X, ORG_GAP_Y, layoutOrg } from "./office";

// The library draws its lines from the right of one node to the left of the next, so the tree runs left to right: Friend on the left, the
// people who report to it to the right, one row for each person in a level.
const STEP_X = 215;
const STEP_Y = 86;

const COLOR: Record<OfficeWorkerView["status"], NodeDef["color"]> = { starting: "green", running: "green", waiting: "amber", idle: "cyan", paused: "ghost", stopped: "ghost", failed: "red" };

/** The Office as a graph drawn with the Jarvis library: Friend at the top, each worker under its manager, with the flow of work along the lines. */
export default function OrgGraph({ workers, name }: { workers: OfficeWorkerView[]; name: string }) {
  const layout = layoutOrg(workers);
  const at = (n: { x: number; y: number }) => ({ x: 30 + Math.round((n.y / (ORG_CARD_H + ORG_GAP_Y)) * STEP_X), y: 36 + Math.round((n.x / (ORG_CARD_W + ORG_GAP_X)) * STEP_Y) });
  const spots = layout.nodes.map((n) => at(n));
  const nodes: NodeDef[] = layout.nodes.map((n, i) =>
    n.worker
      ? { id: n.id, label: n.worker.name.toUpperCase(), sub: n.worker.title, value: n.worker.detail || n.worker.status, ...spots[i]!, color: COLOR[n.worker.status], pulse: n.worker.status === "running" || n.worker.status === "starting" || n.worker.status === "waiting" }
      : { id: n.id, label: name.toUpperCase(), sub: "assistant", ...spots[i]!, type: "hub", color: "cyan" },
  );
  const status = new Map(workers.map((w) => [w.id, w.status] as const));
  const edges: EdgeDef[] = layout.edges.map((e) => ({ from: e.from, to: e.to, arrow: true, animated: status.get(e.to) === "running" || status.get(e.to) === "starting", color: status.get(e.to) === "waiting" ? "amber" : "cyan" }));
  return <JNodeGraph nodes={nodes} edges={edges} height={`${Math.max(...spots.map((s) => s.y)) + 90}px`} width={`${Math.max(...spots.map((s) => s.x)) + 190}px`} showLegend={false} />;
}