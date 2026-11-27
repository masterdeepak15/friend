import type { PcStatus } from "@friend/protocol";
import { DatabaseSync } from "node:sqlite";

export type TaskState = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";
export interface TaskRow {
  id: number;
  title: string;
  state: TaskState;
  note: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface EventRow {
  id: number;
  at: number;
  tool: string;
  ok: boolean;
  window: string;
  detail: string;
}

/** Turns a secret into something only this Windows user can open again (DPAPI), and back. */
export interface Sealer {
  seal(plain: string): Promise<string>;
  unseal(sealed: string): Promise<string>;
}

const MAX_EVENTS = 2000;

/** The agent's own record of itself: settings, sealed tokens, tasks, a trail of what it did, and its last status. One small SQLite file. */
export class AgentStore {
  private readonly db: DatabaseSync;
  private inserts = 0;

  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists kv (key text primary key, value text not null);
      create table if not exists tasks (
        id integer primary key autoincrement, title text not null, state text not null, note text not null default '',
        created_at integer not null, started_at integer, finished_at integer
      );
      create table if not exists events (
        id integer primary key autoincrement, at integer not null, tool text not null, ok integer not null,
        window text not null default '', detail text not null default ''
      );
    `);
  }

  get(key: string): string | null {
    const r = this.db.prepare("select value from kv where key = ?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  set(key: string, value: string): void {
    this.db.prepare("insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, value);
  }
  delete(key: string): void {
    this.db.prepare("delete from kv where key = ?").run(key);
  }

  /** A secret kept only in its sealed form. */
  async setSecret(sealer: Sealer, name: string, plain: string): Promise<void> {
    this.set(`secret:${name}`, await sealer.seal(plain));
  }
  async getSecret(sealer: Sealer, name: string): Promise<string | null> {
    const sealed = this.get(`secret:${name}`);
    if (!sealed) return null;
    try {
      return await sealer.unseal(sealed);
    } catch {
      return null; // sealed for another user or machine: it cannot be read here
    }
  }

  status(): PcStatus | null {
    const raw = this.get("status");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PcStatus;
    } catch {
      return null;
    }
  }
  setStatus(s: PcStatus): void {
    this.set("status", JSON.stringify(s));
  }

  addTask(title: string): TaskRow {
    const id = Number(this.db.prepare("insert into tasks (title, state, created_at) values (?, 'queued', ?)").run(title.slice(0, 200), this.now()).lastInsertRowid);
    return this.task(id)!;
  }
  task(id: number): TaskRow | null {
    const r = this.db.prepare("select * from tasks where id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toTask(r) : null;
  }
  tasks(): TaskRow[] {
    return (this.db.prepare("select * from tasks order by id").all() as Record<string, unknown>[]).map(toTask);
  }
  setTask(id: number, state: TaskState, note?: string): void {
    const t = this.now();
    this.db
      .prepare("update tasks set state = ?, note = coalesce(?, note), started_at = case when ? = 'running' and started_at is null then ? else started_at end, finished_at = case when ? in ('done','failed','cancelled') then ? else finished_at end where id = ?")
      .run(state, note ?? null, state, t, state, t, id);
  }

  addEvent(e: { tool: string; ok: boolean; window?: string; detail?: string }): void {
    this.db.prepare("insert into events (at, tool, ok, window, detail) values (?, ?, ?, ?, ?)").run(this.now(), e.tool, e.ok ? 1 : 0, (e.window ?? "").slice(0, 200), (e.detail ?? "").slice(0, 400));
    if (++this.inserts % 100 === 0) this.db.prepare("delete from events where id <= (select max(id) from events) - ?").run(MAX_EVENTS);
  }
  events(limit = 50): EventRow[] {
    return (this.db.prepare("select * from events order by id desc limit ?").all(limit) as Record<string, unknown>[]).map((r) => ({ id: Number(r.id), at: Number(r.at), tool: String(r.tool), ok: r.ok === 1, window: String(r.window), detail: String(r.detail) }));
  }

  close(): void {
    this.db.close();
  }
}

function toTask(r: Record<string, unknown>): TaskRow {
  return { id: Number(r.id), title: String(r.title), state: r.state as TaskState, note: String(r.note ?? ""), createdAt: Number(r.created_at), startedAt: r.started_at === null ? null : Number(r.started_at), finishedAt: r.finished_at === null ? null : Number(r.finished_at) };
}
