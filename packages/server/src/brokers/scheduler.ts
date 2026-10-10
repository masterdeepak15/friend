import type { ReportSchedules, Schedule } from "./schedules";

export type { Schedule } from "./schedules";

const MAX_TRIES_PER_DAY = 3;
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The calendar day (YYYY-MM-DD) in a time zone. */
export function localDay(now: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The time of day (HH:MM, 24 hour) in a time zone. */
export function localTime(now: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

/** The day of the week in a time zone: 1 = Monday ... 7 = Sunday. */
export function localWeekday(now: Date, zone: string): number {
  return WEEKDAYS[new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(now)] ?? 1;
}

export interface SchedulerDeps {
  schedules: ReportSchedules;
  zone: () => string;
  /** Dates (YYYY-MM-DD) the owner keeps no reports on: market holidays, a holiday of their own. */
  skipDates: () => string[];
  /** Sends one report. Throwing means it could not be sent. */
  run: (s: Schedule) => Promise<void>;
}

/**
 * Looks at the schedules once a minute. A schedule is due when it is enabled, today is one of its days and not a skipped
 * date, its time has come, and it has not run today. Because "has run today" is saved, a restart never sends a report twice,
 * and a report missed while Friend was off goes out as soon as it is back (the same day only).
 */
export class ReportScheduler {
  constructor(private d: SchedulerDeps) {}

  /** Runs what is due. Resolves with how many reports were sent. */
  async tick(now: Date): Promise<number> {
    const zone = this.d.zone();
    const day = localDay(now, zone);
    const time = localTime(now, zone);
    const weekday = localWeekday(now, zone);
    if (this.d.skipDates().includes(day)) return 0;
    let sent = 0;
    for (const s of this.d.schedules.list()) {
      if (!s.enabled || s.lastRunDay === day || !s.days.includes(weekday) || time < s.time) continue;
      if (this.d.schedules.noteAttempt(s.id, day) > MAX_TRIES_PER_DAY) continue;
      try {
        await this.d.run(s);
        this.d.schedules.markRun(s.id, day);
        sent++;
      } catch {
        /* not sent: it is tried again at the next tick, up to three times today */
      }
    }
    return sent;
  }
}
