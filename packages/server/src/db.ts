import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "./migrations";

export type Db = Database.Database;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "friend.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("create table if not exists schema_version (id integer primary key, applied_at integer not null)");
  const applied = new Set(
    (db.prepare("select id from schema_version").all() as { id: number }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("insert into schema_version (id, applied_at) values (?, ?)").run(m.id, Date.now());
    })();
  }
  return db;
}
