import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Audit } from "./audit";
import type { Db } from "./db";

const DAY = 86_400_000;
const APPEND_ONLY = "create trigger audit_no_delete before delete on audit_log begin select raise(abort, 'audit_log is append-only'); end;";

interface Raw {
  id: number;
  ts: number;
  hash: string;
  legacy: number;
}

/**
 * Removes the entries older than `keepDays` (0 keeps everything). The oldest run of entries older than that is first written to a
 * compressed archive (`audit-<fromId>-<toId>.jsonl.gz`, one full entry per line, hashes included), then removed in the same step that
 * writes a checkpoint (range, count, the hash of the last removed entry), so the chain still verifies and the removal is itself on
 * the record. An archive that cannot be written removes nothing.
 */
export function pruneAudit(db: Db, o: { keepDays: number; archive: boolean; dir: string; now: number }): { removed: number; archivePath: string | null } {
  if (o.keepDays <= 0) return { removed: 0, archivePath: null };
  const cutoff = o.now - o.keepDays * DAY;
  // the oldest run of entries that are old enough (time can go backwards, so the run ends at the first entry that is not)
  const all = db.prepare("select id, ts, hash, legacy from audit_log order by id").all() as Raw[];
  let end = -1;
  while (end + 1 < all.length && all[end + 1]!.ts < cutoff) end++;
  if (end < 0) return { removed: 0, archivePath: null };
  const old = all.slice(0, end + 1);
  const fromId = old[0]!.id;
  const toId = old.at(-1)!.id;
  const finalHash = [...old].reverse().find((r) => r.legacy === 0)?.hash ?? "";

  let archivePath: string | null = null;
  if (o.archive) {
    const rows = db.prepare("select * from audit_log where id between ? and ? order by id").all(fromId, toId);
    mkdirSync(o.dir, { recursive: true });
    archivePath = join(o.dir, `audit-${fromId}-${toId}.jsonl.gz`);
    writeFileSync(archivePath, gzipSync(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`));
  }

  const audit = new Audit(db);
  db.transaction(() => {
    db.exec("drop trigger audit_no_delete");
    db.prepare("delete from audit_log where id between ? and ?").run(fromId, toId);
    db.exec(APPEND_ONLY);
    audit.record({ kind: "audit.prune", actorKind: "system", outcome: "done", detail: { fromId, toId, count: old.length, finalHash, archive: archivePath, keepDays: o.keepDays } });
  }).immediate();
  return { removed: old.length, archivePath };
}
