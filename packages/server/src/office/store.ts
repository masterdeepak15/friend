import type { OfficeTicketView, TicketStatus, WorkerStatus } from "@friend/protocol";
import { randomBytes } from "node:crypto";
import type { Db } from "../db";

/** One line of a worker's feed is kept at most this long; nothing longer is ever stored or sent. */
export const MAX_EVENT_CHARS = 200;
/** Only the newest lines of each worker are kept. */
export const MAX_EVENTS_PER_WORKER = 500;

export interface WorkerRow {
  id: string;
  name: string;
  roleId: string;
  projectId: string;
  status: WorkerStatus;
  sessionId: string | null;
  ticketId: number | null;
  detail: string;
  tokens: number;
  createdAt: number;
  startedAt: number | null;
}
export interface TicketRow {
  id: number;
  projectId: string;
  title: string;
  description: string;
  status: TicketStatus;
  workerId: string | null;
  /** What the worker reported when it finished the ticket (read with office.report). */
  report: string;
  createdAt: number;
  updatedAt: number;
}
export interface EventRow {
  id: number;
  workerId: string;
  at: number;
  kind: string;
  text: string;
}

interface WRow {
  id: string;
  name: string;
  role_id: string;
  project_id: string;
  status: WorkerStatus;
  session_id: string | null;
  ticket_id: number | null;
  detail: string;
  tokens: number;
  created_at: number;
  started_at: number | null;
}
interface TRow {
  id: number;
  project_id: string;
  title: string;
  description: string;
  status: TicketStatus;
  worker_id: string | null;
  report: string;
  created_at: number;
  updated_at: number;
}
const toWorker = (r: WRow): WorkerRow => ({ id: r.id, name: r.name, roleId: r.role_id, projectId: r.project_id, status: r.status, sessionId: r.session_id, ticketId: r.ticket_id, detail: r.detail, tokens: r.tokens, createdAt: r.created_at, startedAt: r.started_at });
const toTicket = (r: TRow): TicketRow => ({ id: r.id, projectId: r.project_id, title: r.title, description: r.description, status: r.status, workerId: r.worker_id, report: r.report, createdAt: r.created_at, updatedAt: r.updated_at });

const WORKER_COLUMNS: Record<string, string> = { status: "status", sessionId: "session_id", ticketId: "ticket_id", detail: "detail", startedAt: "started_at" };
const TICKET_COLUMNS: Record<string, string> = { status: "status", workerId: "worker_id", report: "report" };
/** The most of a worker's report that is kept. */
export const MAX_REPORT_CHARS = 20_000;

/** The Office's workers, tickets and a short feed of what each worker did. Only what is needed to draw the screen and to carry on after a restart. */
export class OfficeStore {
  constructor(private db: Db, private now: () => number = Date.now) {}

  createWorker(w: { name: string; roleId: string; projectId: string }): WorkerRow {
    const id = randomBytes(4).toString("hex");
    this.db.prepare("insert into office_workers (id, name, role_id, project_id, created_at) values (?, ?, ?, ?, ?)").run(id, w.name, w.roleId, w.projectId, this.now());
    return this.getWorker(id)!;
  }

  getWorker(id: string): WorkerRow | undefined {
    const r = this.db.prepare("select * from office_workers where id = ?").get(id) as WRow | undefined;
    return r && toWorker(r);
  }

  /** By id, or by name in any case. */
  findWorker(ref: string): WorkerRow | undefined {
    const r = (this.db.prepare("select * from office_workers where id = ?").get(ref) ?? this.db.prepare("select * from office_workers where lower(name) = lower(?) order by created_at limit 1").get(ref)) as WRow | undefined;
    return r && toWorker(r);
  }

  listWorkers(): WorkerRow[] {
    return (this.db.prepare("select * from office_workers order by created_at, id").all() as WRow[]).map(toWorker);
  }

  patchWorker(id: string, p: Partial<Pick<WorkerRow, "status" | "sessionId" | "ticketId" | "detail" | "startedAt">>): void {
    const keys = Object.keys(p).filter((k) => k in WORKER_COLUMNS && (p as Record<string, unknown>)[k] !== undefined);
    if (keys.length === 0) return;
    this.db.prepare(`update office_workers set ${keys.map((k) => `${WORKER_COLUMNS[k]} = ?`).join(", ")} where id = ?`).run(...keys.map((k) => (p as Record<string, unknown>)[k]), id);
  }

  addTokens(id: string, n: number): void {
    this.db.prepare("update office_workers set tokens = tokens + ? where id = ?").run(Math.max(0, Math.round(n)), id);
  }

  removeWorker(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("delete from office_events where worker_id = ?").run(id);
      this.db.prepare("delete from office_workers where id = ?").run(id);
    })();
  }

  createTicket(t: { projectId: string; title: string; description: string }): TicketRow {
    const now = this.now();
    const r = this.db.prepare("insert into office_tickets (project_id, title, description, created_at, updated_at) values (?, ?, ?, ?, ?)").run(t.projectId, t.title, t.description, now, now);
    return this.getTicket(Number(r.lastInsertRowid))!;
  }

  getTicket(id: number): TicketRow | undefined {
    const r = this.db.prepare("select * from office_tickets where id = ?").get(id) as TRow | undefined;
    return r && toTicket(r);
  }

  listTickets(projectId?: string): TicketRow[] {
    const rows = (projectId === undefined ? this.db.prepare("select * from office_tickets order by id") : this.db.prepare("select * from office_tickets where project_id = ? order by id")).all(...(projectId === undefined ? [] : [projectId])) as TRow[];
    return rows.map(toTicket);
  }

  patchTicket(id: number, p: Partial<Pick<TicketRow, "status" | "workerId" | "report">>): void {
    if (p.report !== undefined) p = { ...p, report: p.report.slice(0, MAX_REPORT_CHARS) };
    const keys = Object.keys(p).filter((k) => k in TICKET_COLUMNS && (p as Record<string, unknown>)[k] !== undefined);
    if (keys.length === 0) return;
    this.db.prepare(`update office_tickets set ${keys.map((k) => `${TICKET_COLUMNS[k]} = ?`).join(", ")}, updated_at = ? where id = ?`).run(...keys.map((k) => (p as Record<string, unknown>)[k]), this.now(), id);
  }

  /** Adds a line to a worker's feed, clipped, and drops the oldest lines beyond the newest MAX_EVENTS_PER_WORKER. */
  addEvent(workerId: string, e: { kind: string; text: string; at?: number }): void {
    this.db.prepare("insert into office_events (worker_id, at, kind, text) values (?, ?, ?, ?)").run(workerId, e.at ?? this.now(), e.kind, e.text.slice(0, MAX_EVENT_CHARS));
    this.db
      .prepare("delete from office_events where worker_id = ? and id <= coalesce((select id from office_events where worker_id = ? order by id desc limit 1 offset ?), 0)")
      .run(workerId, workerId, MAX_EVENTS_PER_WORKER);
  }

  /** The newest `limit` lines, oldest first. */
  events(workerId: string, limit = 50): EventRow[] {
    const rows = this.db.prepare("select id, worker_id, at, kind, text from office_events where worker_id = ? order by id desc limit ?").all(workerId, limit) as { id: number; worker_id: string; at: number; kind: string; text: string }[];
    return rows.reverse().map((r) => ({ id: r.id, workerId: r.worker_id, at: r.at, kind: r.kind, text: r.text }));
  }

  /** At start: whatever a crash left running is stopped, and its ticket goes back to the list. */
  resetRunning(): void {
    this.db.transaction(() => {
      this.db.prepare("update office_workers set status = 'stopped' where status in ('starting', 'running', 'waiting')").run();
      this.db.prepare("update office_tickets set status = 'todo', updated_at = ? where status = 'doing'").run(this.now());
    })();
  }

  /** A ticket as the screens see it. */
  ticketView(t: TicketRow): OfficeTicketView {
    return { id: t.id, projectId: t.projectId, title: t.title.slice(0, 200), status: t.status, workerId: t.workerId };
  }
}