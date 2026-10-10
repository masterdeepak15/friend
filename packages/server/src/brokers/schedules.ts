import type { Db } from "../db";
import type { ReportKind } from "./report";

export type ReportChannel = "telegram" | "whatsapp" | "sms";

export interface Schedule {
  id: number;
  name: string;
  broker: string;
  kind: ReportKind;
  /** Local time, HH:MM (24 hour), in the owner's time zone. */
  time: string;
  /** Days of the week, 1 = Monday ... 7 = Sunday. */
  days: number[];
  channel: ReportChannel;
  /** Add a short AI commentary below the numbers (off by default: the numbers cost no model usage). */
  commentary: boolean;
  enabled: boolean;
  /** The local day (YYYY-MM-DD) it last ran, so a restart never sends the same report twice. */
  lastRunDay: string | null;
}

export type NewSchedule = Omit<Schedule, "id" | "lastRunDay">;

export const MAX_SCHEDULES = 20;
const KINDS: readonly string[] = ["morning", "close", "custom"];
const CHANNELS: readonly string[] = ["telegram", "whatsapp", "sms"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Row {
  id: number;
  name: string;
  broker: string;
  kind: string;
  time: string;
  days: string;
  channel: string;
  commentary: number;
  enabled: number;
  last_run_day: string | null;
}

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  name: r.name,
  broker: r.broker,
  kind: r.kind as ReportKind,
  time: r.time,
  days: r.days.split(",").map(Number),
  channel: r.channel as ReportChannel,
  commentary: r.commentary === 1,
  enabled: r.enabled === 1,
  lastRunDay: r.last_run_day,
});

/** The owner's report schedules, kept in the database. Everything is checked on the way in. */
export class ReportSchedules {
  constructor(private db: Db) {}

  list(): Schedule[] {
    return (this.db.prepare("select id, name, broker, kind, time, days, channel, commentary, enabled, last_run_day from report_schedules order by id").all() as Row[]).map(toSchedule);
  }

  add(s: NewSchedule): Schedule {
    const name = typeof s.name === "string" ? s.name.trim() : "";
    if (name.length < 1 || name.length > 60) throw new Error("A schedule needs a name of 1 to 60 characters.");
    if (!KINDS.includes(s.kind)) throw new Error("The kind of report must be morning, close or custom.");
    if (!TIME.test(s.time)) throw new Error("The time must be like 09:30 (24 hour).");
    const days = [...new Set(s.days)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort();
    if (days.length === 0 || days.length !== new Set(s.days).size) throw new Error("Choose the days as numbers 1 (Monday) to 7 (Sunday).");
    if (!CHANNELS.includes(s.channel)) throw new Error("The channel must be telegram, whatsapp or sms.");
    if (typeof s.broker !== "string" || !/^[a-z0-9-]{1,40}$/.test(s.broker)) throw new Error("That is not a broker id.");
    if (this.list().length >= MAX_SCHEDULES) throw new Error(`There can be at most ${MAX_SCHEDULES} schedules.`);
    const info = this.db
      .prepare("insert into report_schedules (name, broker, kind, time, days, channel, commentary, enabled) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(name, s.broker, s.kind, s.time, days.join(","), s.channel, s.commentary ? 1 : 0, s.enabled ? 1 : 0);
    return this.list().find((x) => x.id === Number(info.lastInsertRowid))!;
  }

  remove(id: number): boolean {
    return this.db.prepare("delete from report_schedules where id = ?").run(id).changes > 0;
  }

  markRun(id: number, day: string): void {
    this.db.prepare("update report_schedules set last_run_day = ? where id = ?").run(day, id);
  }

  /** Counts one try for this schedule on this local day and returns how many there have been today (including this one). */
  noteAttempt(id: number, day: string): number {
    const row = this.db.prepare("select attempt_day d, attempts n from report_schedules where id = ?").get(id) as { d: string | null; n: number } | undefined;
    const n = row && row.d === day ? row.n + 1 : 1;
    this.db.prepare("update report_schedules set attempt_day = ?, attempts = ? where id = ?").run(day, n, id);
    return n;
  }
}
