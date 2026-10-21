import type { Db } from "./db";

/** One model turn's token counts. Only numbers and plain labels are kept, never what was said. */
export interface UsageEntry {
  provider: string;
  model: string;
  source: string;
  input: number;
  output: number;
}

export interface DayUsage {
  day: string;
  input: number;
  output: number;
  turns: number;
}
export interface Totals {
  input: number;
  output: number;
  turns: number;
}
export interface ModelUsage extends Totals {
  provider: string;
  model: string;
}
export interface SourceUsage extends Totals {
  source: string;
}
export interface UsageSummary {
  range: number;
  days: DayUsage[];
  total: Totals;
  byModel: ModelUsage[];
  bySource: SourceUsage[];
}

export const USAGE_SOURCES = ["voice", "chat", "task", "channel", "office"] as const;
const DAY_MS = 86_400_000;
/** Counts older than this are removed when Friend starts. */
export const USAGE_KEEP_DAYS = 400;

export interface UsageApi {
  summary(days: number): UsageSummary;
  clear(): number;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The date on this computer's own clock (not UTC) as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const count = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
const label = (s: string, fallback: string) => {
  const t = String(s ?? "").trim().slice(0, 80);
  return /^[\w.:\/@+\- ]+$/.test(t) ? t : fallback;
};

/** Days in the range, clamped; the default for anything that is not a number. */
function range(days: number): number {
  if (!Number.isFinite(days)) return 30;
  return Math.min(366, Math.max(1, Math.floor(days)));
}

export class UsageLog {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  record(e: UsageEntry): void {
    const input = count(e.input);
    const output = count(e.output);
    if (input === 0 && output === 0) return;
    const at = this.now();
    const source = (USAGE_SOURCES as readonly string[]).includes(e.source) ? e.source : "other";
    this.db
      .prepare("insert into usage (at, day, provider, model, source, input, output) values (?, ?, ?, ?, ?, ?, ?)")
      .run(at, localDay(at), label(e.provider, "unknown"), label(e.model, "unknown"), source, input, output);
  }

  /** The first day (local) that a range of `n` days ending today covers. */
  private since(n: number): string {
    return localDay(this.now() - (n - 1) * DAY_MS);
  }

  days(n: number): DayUsage[] {
    const r = range(n);
    const rows = this.db
      .prepare("select day, sum(input) as input, sum(output) as output, count(*) as turns from usage where day >= ? group by day")
      .all(this.since(r)) as DayUsage[];
    const by = new Map(rows.map((x) => [x.day, x]));
    const out: DayUsage[] = [];
    for (let i = r - 1; i >= 0; i--) {
      const day = localDay(this.now() - i * DAY_MS);
      out.push(by.get(day) ?? { day, input: 0, output: 0, turns: 0 });
    }
    return out;
  }

  totals(n: number): Totals {
    const r = this.db
      .prepare("select coalesce(sum(input), 0) as input, coalesce(sum(output), 0) as output, count(*) as turns from usage where day >= ?")
      .get(this.since(range(n))) as Totals;
    return { input: r.input, output: r.output, turns: r.turns };
  }

  byModel(n: number): ModelUsage[] {
    return this.db
      .prepare("select provider, model, sum(input) as input, sum(output) as output, count(*) as turns from usage where day >= ? group by provider, model order by sum(input) + sum(output) desc, model")
      .all(this.since(range(n))) as ModelUsage[];
  }

  bySource(n: number): SourceUsage[] {
    return this.db
      .prepare("select source, sum(input) as input, sum(output) as output, count(*) as turns from usage where day >= ? group by source order by sum(input) + sum(output) desc, source")
      .all(this.since(range(n))) as SourceUsage[];
  }

  summary(n: number): UsageSummary {
    const r = range(n);
    return { range: r, days: this.days(r), total: this.totals(r), byModel: this.byModel(r), bySource: this.bySource(r) };
  }

  /** Removes rows older than `keepDays` days. Returns how many went. */
  prune(keepDays: number): number {
    return this.db.prepare("delete from usage where day < ?").run(this.since(Math.max(1, Math.floor(keepDays)))).changes;
  }

  clear(): number {
    return this.db.prepare("delete from usage").run().changes;
  }
}
