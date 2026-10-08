import type { Db } from "./db";

export const MAX_MEMORIES = 200;
export const MAX_MEMORY_CHARS = 500;
const SEARCH_LIMIT = 10;

export interface MemoryRow {
  id: number;
  text: string;
  source: "owner" | "agent";
  createdAt: number;
}

export type AddResult = { ok: true; id: number; duplicate: boolean } | { ok: false; error: string };

interface Row {
  id: number;
  text: string;
  source: "owner" | "agent";
  created_at: number;
}
const toRow = (r: Row): MemoryRow => ({ id: r.id, text: r.text, source: r.source, createdAt: r.created_at });

/** Short notes about the owner that survive across conversations. The owner can list and delete every one. */
export class Memory {
  constructor(
    private db: Db,
    private clock: () => number = Date.now,
  ) {}

  add(text: string, source: "owner" | "agent"): AddResult {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return { ok: false, error: "There is nothing to remember." };
    if (clean.length > MAX_MEMORY_CHARS) return { ok: false, error: `That note is too long (the limit is ${MAX_MEMORY_CHARS} characters).` };
    const same = this.db.prepare("select id from memories where lower(text) = lower(?)").get(clean) as { id: number } | undefined;
    if (same) return { ok: true, id: same.id, duplicate: true };
    if (this.count() >= MAX_MEMORIES) return { ok: false, error: "Memory is full. Forget something first." };
    const info = this.db.prepare("insert into memories (text, source, created_at) values (?, ?, ?)").run(clean, source, this.clock());
    return { ok: true, id: Number(info.lastInsertRowid), duplicate: false };
  }

  count(): number {
    return (this.db.prepare("select count(*) c from memories").get() as { c: number }).c;
  }

  list(): MemoryRow[] {
    return (this.db.prepare("select id, text, source, created_at from memories order by id desc").all() as Row[]).map(toRow);
  }

  recent(limit: number): MemoryRow[] {
    return (this.db.prepare("select id, text, source, created_at from memories order by id desc limit ?").all(limit) as Row[]).map(toRow);
  }

  /** Every word of the query must appear (any case). `%` and `_` are ordinary characters. */
  search(query: string, limit = SEARCH_LIMIT): MemoryRow[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const where = words.map(() => "lower(text) like ? escape '\\'").join(" and ");
    const args = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = this.db
      .prepare(`select id, text, source, created_at from memories where ${where} order by id desc limit ?`)
      .all(...args, Math.min(limit, SEARCH_LIMIT)) as Row[];
    return rows.map(toRow);
  }

  forget(id: number): boolean {
    return this.db.prepare("delete from memories where id = ?").run(id).changes > 0;
  }

  clear(): number {
    return this.db.prepare("delete from memories").run().changes;
  }
}
