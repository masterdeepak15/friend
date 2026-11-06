import { toAuditRow, type ActorKind, type AuditRow, type Outcome } from "./audit";
import type { Db } from "./db";

export type KindGroup = "approvals" | "tools" | "workers" | "logins" | "messages" | "settings" | "system" | "other";

export interface AuditFilter {
  from?: number;
  to?: number;
  actorKind?: ActorKind;
  actorId?: string;
  group?: KindGroup;
  outcome?: Outcome;
  q?: string;
  requestId?: string;
  /** Entries older than this id (the next page). */
  before?: number;
  limit?: number;
}

export interface AuditNode {
  row: AuditRow;
  children: AuditNode[];
}

/** The kind prefixes of each group (`prefix.` matches everything under it, a name without a dot matches exactly). */
const GROUPS: Record<Exclude<KindGroup, "other">, string[]> = {
  approvals: ["approval."],
  tools: ["tool."],
  workers: ["worker.", "office.", "ticket."],
  logins: ["login.", "pin.", "secrets.", "sessions.", "device.", "host.", "ws.origin", "http.flood", "setup.", "chrome.remote_refused", "alexa.refused", "alexa.unknown", "channel.twilio_refused"],
  messages: ["request", "message.", "owner.notified", "channel.", "voice.utterance"],
  settings: ["settings.", "config.", "plugin", "connector", "soul.", "usage."],
  system: ["system.", "audit.", "voice.", "task.", "session.", "proactive.", "provider.", "agent.", "memory."],
};

const matches = (kind: string, prefix: string): boolean => kind.startsWith(prefix);

export function groupOf(kind: string): KindGroup {
  for (const [group, prefixes] of Object.entries(GROUPS) as [Exclude<KindGroup, "other">, string[]][]) if (prefixes.some((p) => matches(kind, p))) return group;
  return "other";
}

const MAX_LIMIT = 500;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One SQL condition for "this kind belongs to the group", with its values. */
function groupSql(group: KindGroup): { sql: string; args: string[] } {
  if (group !== "other") {
    const prefixes = GROUPS[group];
    return { sql: `(${prefixes.map(() => "kind like ? escape '\\'").join(" or ")})`, args: prefixes.map((p) => `${likeEscape(p)}%`) };
  }
  const all = Object.values(GROUPS).flat();
  return { sql: `not (${all.map(() => "kind like ? escape '\\'").join(" or ")})`, args: all.map((p) => `${likeEscape(p)}%`) };
}

/** Reading the trail: filters, one request's whole story, what needs attention. Parameterized SQL only. */
export class AuditQuery {
  constructor(private db: Db) {}

  private where(f: AuditFilter): { sql: string; args: unknown[] } {
    const c: string[] = [];
    const args: unknown[] = [];
    if (f.from !== undefined) (c.push("ts >= ?"), args.push(f.from));
    if (f.to !== undefined) (c.push("ts <= ?"), args.push(f.to));
    if (f.actorKind) (c.push("actor_kind = ?"), args.push(f.actorKind));
    if (f.actorId) (c.push("actor_id = ?"), args.push(f.actorId));
    if (f.outcome) (c.push("outcome = ?"), args.push(f.outcome));
    if (f.requestId) (c.push("request_id = ?"), args.push(f.requestId));
    if (f.before !== undefined) (c.push("id < ?"), args.push(f.before));
    if (f.group) {
      const g = groupSql(f.group);
      c.push(g.sql);
      args.push(...g.args);
    }
    if (f.q) {
      const like = `%${likeEscape(f.q)}%`;
      c.push("(kind like ? escape '\\' or target like ? escape '\\' or actor_id like ? escape '\\' or detail_json like ? escape '\\')");
      args.push(like, like, like, like);
    }
    return { sql: c.length ? `where ${c.join(" and ")}` : "", args };
  }

  search(f: AuditFilter = {}): AuditRow[] {
    const w = this.where(f);
    const limit = Math.min(Math.max(Math.floor(f.limit ?? 100), 1), MAX_LIMIT);
    return (this.db.prepare(`select * from audit_log ${w.sql} order by id desc limit ?`).all(...w.args, limit) as never[]).map(toAuditRow);
  }

  counts(f: AuditFilter = {}): { total: number; refused: number; failed: number } {
    const w = this.where({ ...f, limit: undefined });
    const n = (extra: string) => (this.db.prepare(`select count(*) n from audit_log ${w.sql}${w.sql ? " and " : "where "}${extra}`).get(...w.args) as { n: number }).n;
    return { total: (this.db.prepare(`select count(*) n from audit_log ${w.sql}`).get(...w.args) as { n: number }).n, refused: n("outcome = 'refused'"), failed: n("outcome = 'failed'") };
  }

  /** Everything one request caused: its own entries in order, and each request it started nested under the entry that came just before it. */
  tree(requestId: string, depth = 0): AuditNode[] {
    if (depth > 6) return [];
    const own = (this.db.prepare("select * from audit_log where request_id = ? order by id limit 2000").all(requestId) as never[]).map(toAuditRow);
    if (!own.length) return [];
    const nodes: AuditNode[] = own.map((row) => ({ row, children: [] }));
    const kids = this.db.prepare("select request_id, min(id) first from audit_log where parent_id = ? and request_id is not null group by request_id order by first").all(requestId) as { request_id: string; first: number }[];
    for (const k of kids) {
      const owner = [...nodes].reverse().find((n) => n.row.id < k.first) ?? nodes[0]!;
      owner.children.push(...this.tree(k.request_id, depth + 1));
    }
    return nodes;
  }

  /** What deserves a look since a time: refused and failed entries, outsiders, approvals nobody answered, and anything that was not recorded. */
  attention(sinceMs: number): AuditRow[] {
    return (this.db
      .prepare("select * from audit_log where ts >= ? and (outcome in ('refused','failed') or actor_kind = 'outsider' or kind = 'approval.timeout' or detail_json like '%\"notRecorded\"%') order by id desc limit 200")
      .all(sinceMs) as never[]).map(toAuditRow);
  }

  /** The workers that have acted, newest first. */
  workers(): { id: string; name: string; last: number }[] {
    return (this.db.prepare("select actor_id id, max(ts) last from audit_log where actor_kind = 'worker' and actor_id != '' group by actor_id order by last desc").all() as { id: string; last: number }[]).map((r) => ({ id: r.id, name: r.id, last: r.last }));
  }
}
