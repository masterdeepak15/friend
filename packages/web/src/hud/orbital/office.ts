import type { OfficeQuota, OfficeTicketView, OfficeWorkerView } from "@friend/protocol";
import type { OfficeFeedLine } from "../../store";
import { clamp, type NodeStatus, type TicketStatus } from "./kit";

/** How many workers the orbit has room for (its slots). */
export const MAX_ORBIT_WORKERS = 5;
/** How many ticket cells the honeycomb has room for. */
export const MAX_CELLS = 11;

/** One node of the orbit that stands for a worker, or for the place to hire one. */
export interface WorkerNode {
  id: string;
  /** The whole name (read out by a screen reader). */
  label: string;
  /** What is drawn inside the hexagon: the first six characters. */
  glyph: string;
  /** The whole name, under the hexagon. */
  caption: string;
  status: NodeStatus;
  /** What the worker is doing, or why it is not. */
  detail: string;
  kind: "worker" | "hire";
}

const NODE_STATUS: Record<OfficeWorkerView["status"], NodeStatus> = { starting: "running", running: "running", waiting: "waiting", idle: "idle", paused: "idle", stopped: "idle", failed: "idle" };

export function workerNodes(workers: OfficeWorkerView[], enabled: boolean): WorkerNode[] {
  const nodes: WorkerNode[] = workers.slice(0, MAX_ORBIT_WORKERS).map((w) => ({
    id: w.id,
    label: w.name,
    glyph: w.name.slice(0, 6).toUpperCase(),
    caption: w.name,
    status: NODE_STATUS[w.status],
    detail: w.detail || w.status,
    kind: "worker" as const,
  }));
  if (enabled && workers.length < MAX_ORBIT_WORKERS) nodes.push({ id: "hire", label: "Hire a worker", glyph: "+", caption: "HIRE WORKER", status: "add", detail: "HIRE WORKER", kind: "hire" });
  return nodes;
}

const CELL_STATUS: Record<OfficeTicketView["status"], TicketStatus> = { done: "done", doing: "doing", review: "review", blocked: "review", todo: "todo" };
const CELL_ORDER: TicketStatus[] = ["done", "doing", "review", "todo"];

/** The newest tickets, one cell each, grouped as done, doing, review, todo. */
export function ticketCells(tickets: OfficeTicketView[]): { status: TicketStatus }[] {
  return [...tickets]
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_CELLS)
    .map((t) => ({ status: CELL_STATUS[t.status] }))
    .sort((a, b) => CELL_ORDER.indexOf(a.status) - CELL_ORDER.indexOf(b.status));
}

/** The title of the honeycomb: the project when all tickets are in one. */
export function ticketProject(tickets: OfficeTicketView[]): string | undefined {
  const projects = [...new Set(tickets.map((t) => t.projectId))];
  if (projects.length === 0) return undefined;
  return projects.length === 1 ? projects[0] : `${projects.length} projects`;
}

const short = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/**
 * One ring for each of up to three workers. With limits set, the share of its limit a worker has used; with none, what each has used
 * against the busiest worker, so the instrument shows the work instead of staying empty.
 */
export function budgetRings(workers: OfficeWorkerView[]): { label: string; value: number; text: string }[] {
  const label = (w: OfficeWorkerView) => w.name.slice(0, 6).toUpperCase();
  const limited = workers.filter((w) => w.budget !== null && w.budget > 0);
  if (limited.length > 0) {
    return limited.slice(0, 3).map((w) => {
      const value = clamp((w.tokens / w.budget!) * 100);
      return { label: label(w), value, text: `${Math.round(value)}%` };
    });
  }
  const busiest = Math.max(0, ...workers.map((w) => w.tokens));
  return [...workers]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 3)
    .map((w) => ({ label: label(w), value: busiest > 0 ? clamp(Math.max(w.tokens > 0 ? 1 : 0, Math.round((w.tokens / busiest) * 100))) : 0, text: short(w.tokens) }));
}
const TONE: Record<string, "green" | "orange" | "plain"> = { tool: "green", result: "green", approval: "orange", error: "orange", text: "plain" };

/** What the name in the middle says: Friend's own state, or, while he is idle, what the office is doing. */
export function officeMood(mode: string, office: { enabled: boolean; workers: OfficeWorkerView[] }): string {
  if (mode !== "idle" || !office.enabled) return mode;
  if (office.workers.some((w) => w.status === "waiting")) return "needs you";
  const busy = office.workers.filter((w) => w.status === "running" || w.status === "starting").length;
  return busy > 0 ? `working · ${busy}` : mode;
}

/** The newest lines of every worker's feed, oldest first, each starting with the worker's name. */
export function feedLines(feed: Record<string, OfficeFeedLine[]>, workers: OfficeWorkerView[], limit = 8): { text: string; tone: "green" | "orange" | "plain" }[] {
  const all = workers.flatMap((w) => (feed[w.id] ?? []).map((l) => ({ ...l, name: w.name.slice(0, 6).toUpperCase().padEnd(7) })));
  return all
    .sort((a, b) => a.at - b.at)
    .slice(-limit)
    .map((l) => ({ text: `${l.name}${l.text}`, tone: TONE[l.kind] ?? "plain" }));
}

const resetText = (ms: number): string => {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}H ${String(mins % 60).padStart(2, "0")}M`.replace(/ 0(\d)M/, " $1M") : `${mins}M`;
};

/**
 * What the usage ring shows: the real five-hour window of the owner's subscription when the workers have reported it (and it has not
 * reset since), otherwise today's usage against the busiest day.
 */
export function usageFromQuota(quota: OfficeQuota, fallback: number | null, nowMs: number): { value: number | null; reset: string | null; real: boolean } {
  const w = quota.fiveHour;
  if (w && w.resetsAt * 1000 > nowMs) return { value: Math.round(clamp(w.utilization * 100)), reset: resetText(w.resetsAt * 1000 - nowMs), real: true };
  return { value: fallback, reset: null, real: false };
}

export const ORG_CARD_W = 190;
export const ORG_CARD_H = 78;
export const ORG_GAP_X = 26;
export const ORG_GAP_Y = 56;

export interface OrgNode {
  id: string;
  x: number;
  y: number;
  /** null: Friend, at the top. */
  worker: OfficeWorkerView | null;
}
export interface OrgEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The tree of who reports to whom, with Friend at the top: each card centred over the ones that report to it, none on its neighbour.
 * A worker whose manager is gone, or that is part of a reporting loop, hangs from Friend, so nobody drops out of the picture.
 */
export function layoutOrg(workers: OfficeWorkerView[]): { nodes: OrgNode[]; edges: OrgEdge[]; width: number; height: number } {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const inLoop = (w: OfficeWorkerView): boolean => {
    const seen = new Set<string>([w.id]);
    for (let m = w.managerId; m && byId.has(m); m = byId.get(m)!.managerId) {
      if (seen.has(m)) return m === w.id;
      seen.add(m);
    }
    return false;
  };
  const parentOf = (w: OfficeWorkerView): string => (w.managerId && byId.has(w.managerId) && !inLoop(w) ? w.managerId : "friend");
  const kids = new Map<string, OfficeWorkerView[]>();
  for (const w of workers) kids.set(parentOf(w), [...(kids.get(parentOf(w)) ?? []), w]);

  const width = new Map<string, number>();
  const measure = (id: string): number => {
    const ch = kids.get(id) ?? [];
    const w = ch.length === 0 ? ORG_CARD_W : Math.max(ORG_CARD_W, ch.reduce((s, c) => s + measure(c.id), 0) + (ch.length - 1) * ORG_GAP_X);
    width.set(id, w);
    return w;
  };
  measure("friend");

  const nodes: OrgNode[] = [];
  const edges: OrgEdge[] = [];
  let deepest = 0;
  const place = (id: string, left: number, depth: number): number => {
    deepest = Math.max(deepest, depth);
    const ch = kids.get(id) ?? [];
    const y = depth * (ORG_CARD_H + ORG_GAP_Y);
    let x: number;
    if (ch.length === 0) x = left + (width.get(id)! - ORG_CARD_W) / 2;
    else {
      let cursor = left;
      const xs = ch.map((c) => {
        const cx = place(c.id, cursor, depth + 1);
        cursor += width.get(c.id)! + ORG_GAP_X;
        return cx;
      });
      x = (xs[0]! + xs[xs.length - 1]!) / 2;
      for (const [i, c] of ch.entries()) edges.push({ from: id, to: c.id, x1: x + ORG_CARD_W / 2, y1: y + ORG_CARD_H, x2: xs[i]! + ORG_CARD_W / 2, y2: y + ORG_CARD_H + ORG_GAP_Y });
    }
    nodes.push({ id, x, y, worker: id === "friend" ? null : byId.get(id)! });
    return x;
  };
  place("friend", 0, 0);
  return { nodes, edges, width: width.get("friend")!, height: (deepest + 1) * ORG_CARD_H + deepest * ORG_GAP_Y };
}