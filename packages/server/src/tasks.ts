import type { Db } from "./db";

export const MAX_OPEN_TASKS = 200;
export const MAX_TITLE_CHARS = 200;

export type Repeat = "hourly" | "daily" | "weekly";
const STEP: Record<Repeat, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };

export interface TaskRow {
  id: number;
  title: string;
  /** Epoch milliseconds, or null for a plain to-do. */
  dueAt: number | null;
  repeat: Repeat | null;
}

interface Row {
  id: number;
  title: string;
  due_at: number | null;
  repeat: Repeat | null;
}
const toRow = (r: Row): TaskRow => ({ id: r.id, title: r.title, dueAt: r.due_at, repeat: r.repeat });
const COLUMNS = "id, title, due_at, repeat";

/** The first slot of a repeating task that lies after `after`, counted from its current slot. */
function nextSlot(due: number, step: number, after: number): number {
  const next = due + step;
  return next > after ? next : due + (Math.floor((after - due) / step) + 1) * step;
}

/** A date as local time with its UTC offset ("2026-10-08T17:30:00+05:30"), so the model can read and write times without guessing the zone. */
export function localIso(d: Date): string {
  const p = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

/** To-dos and timed reminders. A reminder only ever notifies the owner; nothing here runs a command. */
export class Tasks {
  constructor(
    private db: Db,
    private clock: () => number = Date.now,
  ) {}

  now(): number {
    return this.clock();
  }

  add(input: { title: string; dueAt?: number | null; repeat?: Repeat | null }): { ok: true; id: number } | { ok: false; error: string } {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title) return { ok: false, error: "A task needs a title." };
    if (title.length > MAX_TITLE_CHARS) return { ok: false, error: `That title is too long (the limit is ${MAX_TITLE_CHARS} characters).` };
    const dueAt = input.dueAt ?? null;
    if (dueAt !== null) {
      if (!Number.isFinite(dueAt)) return { ok: false, error: "That time is not valid." };
      if (dueAt <= this.clock()) return { ok: false, error: "That time has already passed." };
    }
    const repeat = input.repeat ?? null;
    if (repeat && dueAt === null) return { ok: false, error: "A repeating task needs a time." };
    if (this.openCount() >= MAX_OPEN_TASKS) return { ok: false, error: "The task list is full. Finish or remove something first." };
    const info = this.db
      .prepare("insert into tasks (title, due_at, repeat, status, created_at) values (?, ?, ?, 'open', ?)")
      .run(title, dueAt, repeat, this.clock());
    return { ok: true, id: Number(info.lastInsertRowid) };
  }

  private openCount(): number {
    return (this.db.prepare("select count(*) c from tasks where status = 'open'").get() as { c: number }).c;
  }

  /** Open tasks, soonest first; plain to-dos last. */
  list(): TaskRow[] {
    const rows = this.db
      .prepare(`select ${COLUMNS} from tasks where status = 'open' order by due_at is null, due_at, id`)
      .all() as Row[];
    return rows.map(toRow);
  }

  done(id: number): { ok: true; rescheduled: boolean } | { ok: false; error: string } {
    const row = this.db.prepare(`select ${COLUMNS} from tasks where id = ? and status = 'open'`).get(id) as Row | undefined;
    if (!row) return { ok: false, error: "No open task with that number." };
    if (row.repeat && row.due_at !== null) {
      this.db
        .prepare("update tasks set due_at = ?, fired_at = null where id = ?")
        .run(nextSlot(row.due_at, STEP[row.repeat], this.clock()), id);
      return { ok: true, rescheduled: true };
    }
    this.db.prepare("update tasks set status = 'done' where id = ?").run(id);
    return { ok: true, rescheduled: false };
  }

  remove(id: number): boolean {
    return this.db.prepare("delete from tasks where id = ?").run(id).changes > 0;
  }

  /** Open tasks whose time has come and that have not been announced yet. */
  due(): TaskRow[] {
    const rows = this.db
      .prepare(`select ${COLUMNS} from tasks where status = 'open' and due_at is not null and due_at <= ? and fired_at is null order by due_at, id`)
      .all(this.clock()) as Row[];
    return rows.map(toRow);
  }

  /** The owner has been told. A repeating task moves to its next slot after now (missed slots are skipped, never replayed). */
  markFired(id: number): void {
    const row = this.db.prepare(`select ${COLUMNS} from tasks where id = ?`).get(id) as Row | undefined;
    if (!row) return;
    if (row.repeat && row.due_at !== null) {
      this.db.prepare("update tasks set due_at = ?, fired_at = null where id = ?").run(nextSlot(row.due_at, STEP[row.repeat], this.clock()), id);
    } else {
      this.db.prepare("update tasks set fired_at = ? where id = ?").run(this.clock(), id);
    }
  }
}
