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

/** The share of its limit each worker has used (up to three workers that have a limit). */
export function budgetRings(workers: OfficeWorkerView[]): { label: string; value: number }[] {
  return workers
    .filter((w) => w.budget !== null && w.budget > 0)
    .slice(0, 3)
    .map((w) => ({ label: w.name.slice(0, 6).toUpperCase(), value: clamp((w.tokens / w.budget!) * 100) }));
}

const TONE: Record<string, "green" | "orange" | "plain"> = { tool: "green", result: "green", approval: "orange", error: "orange", text: "plain" };

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
