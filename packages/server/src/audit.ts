import type { Db } from "./db";

export interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  kind: string;
  detail: Record<string, unknown>;
}

const SECRET_KEY = /pass(word)?|pin|token|secret|key|authorization|cookie/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export class Audit {
  constructor(private db: Db, private clock: () => number = Date.now) {}

  log(actor: string, kind: string, detail: object = {}): void {
    this.db
      .prepare("insert into audit_log (ts, actor, kind, detail_json) values (?, ?, ?, ?)")
      .run(this.clock(), actor, kind, JSON.stringify(redact(detail)));
  }

  list(limit: number): AuditRow[] {
    const rows = this.db
      .prepare("select id, ts, actor, kind, detail_json from audit_log order by id desc limit ?")
      .all(limit) as { id: number; ts: number; actor: string; kind: string; detail_json: string }[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, kind: r.kind, detail: JSON.parse(r.detail_json) }));
  }
}
