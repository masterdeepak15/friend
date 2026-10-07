import type { Db } from "../db";
import { isSimpleCommand } from "./classify";

export interface Matcher {
  /** All arguments must equal these exactly (same keys, same values). */
  argEquals?: Record<string, unknown>;
  /** The shell command must equal this exactly and must be a simple command. */
  command?: string;
}
export interface Rule {
  id: number;
  tool: string;
  matcher: Matcher;
  createdAt: number;
}

export class RuleStore {
  constructor(private db: Db) {}

  add(tool: string, matcher: Matcher): number {
    const r = this.db
      .prepare("insert into rules (tool, matcher_json, created_at) values (?, ?, ?)")
      .run(tool, JSON.stringify(matcher), Date.now());
    return Number(r.lastInsertRowid);
  }

  list(): Rule[] {
    const rows = this.db.prepare("select id, tool, matcher_json, created_at from rules order by id").all() as {
      id: number;
      tool: string;
      matcher_json: string;
      created_at: number;
    }[];
    return rows.map((r) => ({ id: r.id, tool: r.tool, matcher: JSON.parse(r.matcher_json), createdAt: r.created_at }));
  }

  remove(id: number): void {
    this.db.prepare("delete from rules where id = ?").run(id);
  }

  matches(tool: string, args: unknown): boolean {
    const a = (args ?? {}) as Record<string, unknown>;
    return this.list().some((r) => r.tool === tool && matcherMatches(r.matcher, a));
  }
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

function matcherMatches(m: Matcher, args: Record<string, unknown>): boolean {
  if (m.command === undefined && m.argEquals === undefined) return false;
  if (m.command !== undefined) {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (!isSimpleCommand(cmd) || cmd !== m.command.trim()) return false;
    const { command: _c, cwd, ...rest } = args;
    if (Object.keys(rest).length > 0 || (cwd !== undefined && typeof cwd !== "string")) return false;
  }
  if (m.argEquals && stable(m.argEquals) !== stable(args)) return false;
  return true;
}
