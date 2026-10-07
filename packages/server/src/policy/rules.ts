import type { Db } from "../db";
import { isSimpleCommand } from "./classify";

export interface Matcher {
  argEquals?: Record<string, unknown>;
  commandPrefix?: string;
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

function matcherMatches(m: Matcher, args: Record<string, unknown>): boolean {
  if (m.commandPrefix === undefined && m.argEquals === undefined) return false;
  if (m.commandPrefix !== undefined) {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (!isSimpleCommand(cmd)) return false;
    if (!(cmd === m.commandPrefix || cmd.startsWith(m.commandPrefix + " "))) return false;
  }
  if (m.argEquals) {
    for (const [k, v] of Object.entries(m.argEquals)) if (args[k] !== v) return false;
  }
  return true;
}
