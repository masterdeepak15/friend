import type { OfficeWorkerView } from "@friend/protocol";
import { ORG_CARD_H, ORG_CARD_W, ORG_GAP_X, ORG_GAP_Y, layoutOrg } from "./office";

/** The size of one node on the canvas, and the room between nodes. */
export const NODE_W = 240;
export const NODE_H = 140;
const STEP_X = NODE_W + 110;
const STEP_Y = NODE_H + 34;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;
const FIT_PADDING = 28;
/** How much of the team must stay in view however far it is pushed. */
const KEEP = 96;

export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  /** null: the assistant, at the left. */
  worker: OfficeWorkerView | null;
}
export interface CanvasEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface View {
  x: number;
  y: number;
  k: number;
}
interface Size {
  width: number;
  height: number;
}

/** The team laid out for a canvas: each level a step to the right of its manager, each person in a row of their own, lines from one node's right side to the next one's left. */
export function canvasLayout(workers: OfficeWorkerView[]): Size & { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const tree = layoutOrg(workers);
  const at = (n: { x: number; y: number }) => ({ x: Math.round((n.y / (ORG_CARD_H + ORG_GAP_Y)) * STEP_X), y: Math.round((n.x / (ORG_CARD_W + ORG_GAP_X)) * STEP_Y) });
  const nodes: CanvasNode[] = tree.nodes.map((n) => ({ id: n.id, worker: n.worker, ...at(n) }));
  const spot = new Map(nodes.map((n) => [n.id, n] as const));
  const edges: CanvasEdge[] = tree.edges.map((e) => {
    const a = spot.get(e.from)!;
    const b = spot.get(e.to)!;
    return { from: e.from, to: e.to, x1: a.x + NODE_W, y1: a.y + NODE_H / 2, x2: b.x, y2: b.y + NODE_H / 2 };
  });
  // the first node's row is wherever the tree put it: shift everything so the top row starts at 0
  const top = Math.min(...nodes.map((n) => n.y));
  for (const n of nodes) n.y -= top;
  for (const e of edges) {
    e.y1 -= top;
    e.y2 -= top;
  }
  return { nodes, edges, width: Math.max(...nodes.map((n) => n.x)) + NODE_W, height: Math.max(...nodes.map((n) => n.y)) + NODE_H };
}

const clampK = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** The view that shows the whole team in the room, centred, and not larger than life. */
export function fitView(world: Size, room: Size): View {
  const k = clampK(Math.min((room.width - 2 * FIT_PADDING) / world.width, (room.height - 2 * FIT_PADDING) / world.height, 1.25));
  return { k, x: (room.width - world.width * k) / 2, y: (room.height - world.height * k) / 2 };
}

/** Zooms by a factor around a point of the room, which stays where it is. */
export function zoomAt(v: View, point: { x: number; y: number }, factor: number): View {
  const k = clampK(v.k * factor);
  const f = k / v.k;
  return { k, x: point.x - (point.x - v.x) * f, y: point.y - (point.y - v.y) * f };
}

/** Keeps some of the team in view: it can be moved about but never lost off the edge. */
export function clampView(v: View, world: Size, room: Size): View {
  const w = world.width * v.k;
  const h = world.height * v.k;
  const keepX = Math.min(KEEP, w);
  const keepY = Math.min(KEEP, h);
  return {
    k: v.k,
    x: Math.min(room.width - keepX, Math.max(keepX - w, v.x)),
    y: Math.min(room.height - keepY, Math.max(keepY - h, v.y)),
  };
}