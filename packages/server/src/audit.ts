import { createHash } from "node:crypto";
import { currentRequest } from "./auditContext";
import { redactDetail } from "./auditRedact";
import type { Db } from "./db";

export type ActorKind = "owner" | "assistant" | "worker" | "system" | "outsider";
export type Outcome = "started" | "done" | "refused" | "failed" | "waiting";

export interface AuditRow {
  id: number;
  ts: number;
  /** The old actor text (owner, agent, system, anonymous), kept so earlier readers keep working. */
  actor: string;
  actorKind: ActorKind;
  actorId: string;
  requestId: string | null;
  parentId: string | null;
  kind: string;
  /** What was acted on: a tool, a file, a URL, a recipient. */
  target: string;
  outcome: Outcome | "";
  detail: Record<string, unknown>;
  truncated: boolean;
  /** Written before the chain existed: not covered by it. */
  legacy: boolean;
  prevHash: string;
  hash: string;
}

export interface RecordInput {
  kind: string;
  actorKind: ActorKind;
  actorId?: string;
  target?: string;
  outcome?: Outcome;
  detail?: object;
  requestId?: string | null;
  parentId?: string | null;
}

export type VerifyResult = { ok: true; rows: number; lastHash: string } | { ok: false; brokenAt: number; reason: "hash" | "link" | "gap" };

/** What an entry's hash covers: everything but its id, so the order is only the chain's own links. */
export function rowHash(f: { ts: number; actorKind: string; actorId: string; requestId: string | null; parentId: string | null; kind: string; target: string; outcome: string; detailJson: string; prevHash: string }): string {
  return createHash("sha256").update(JSON.stringify([f.ts, f.actorKind, f.actorId, f.requestId, f.parentId, f.kind, f.target, f.outcome, f.detailJson, f.prevHash])).digest("hex");
}

const KIND_OF_ACTOR: Record<string, ActorKind> = { owner: "owner", agent: "assistant", system: "system", anonymous: "outsider" };
const ACTOR_OF_KIND: Record<ActorKind, string> = { owner: "owner", assistant: "agent", worker: "agent", system: "system", outsider: "anonymous" };

interface Raw {
  id: number;
  ts: number;
  actor: string;
  actor_kind: string;
  actor_id: string;
  request_id: string | null;
  parent_id: string | null;
  kind: string;
  target: string;
  outcome: string;
  detail_json: string;
  truncated: number;
  legacy: number;
  prev_hash: string;
  hash: string;
}

const toRow = (r: Raw): AuditRow => ({
  id: r.id,
  ts: r.ts,
  actor: r.actor,
  actorKind: (r.actor_kind || KIND_OF_ACTOR[r.actor] || "system") as ActorKind,
  actorId: r.actor_id,
  requestId: r.request_id,
  parentId: r.parent_id,
  kind: r.kind,
  target: r.target,
  outcome: r.outcome as Outcome | "",
  detail: JSON.parse(r.detail_json) as Record<string, unknown>,
  truncated: r.truncated === 1,
  legacy: r.legacy === 1,
  prevHash: r.prev_hash,
  hash: r.hash,
});

export class Audit {
  constructor(private db: Db, private clock: () => number = Date.now) {
    this.ensureStart();
  }

  /** The old actor text is kept as it was; its kind is worked out from it. */
  log(actor: string, kind: string, detail: object = {}): void {
    const ctx = currentRequest();
    // inside a worker's run the old "agent" actor is the worker
    const asWorker = actor === "agent" && ctx?.actorKind === "worker";
    this.append({ kind, actorKind: asWorker ? "worker" : (KIND_OF_ACTOR[actor] ?? "system"), ...(asWorker && ctx?.actorId ? { actorId: ctx.actorId } : {}), detail }, actor);
  }

  /** Writes one entry and returns its id. Throws when it cannot be written. */
  record(i: RecordInput): number {
    return this.append(i, ACTOR_OF_KIND[i.actorKind]);
  }

  list(limit: number): AuditRow[] {
    return (this.db.prepare("select * from audit_log order by id desc limit ?").all(limit) as Raw[]).map(toRow);
  }

  /** The newest chained entry. */
  last(): { id: number; hash: string } | null {
    const r = this.db.prepare("select id, hash from audit_log where legacy = 0 order by id desc limit 1").get() as { id: number; hash: string } | undefined;
    return r ?? null;
  }

  /** Walks the chain: every entry must link to the one before and hash to what it says. */
  verify(): VerifyResult {
    const rows = this.db.prepare("select * from audit_log where legacy = 0 order by id").all() as Raw[];
    const checkpoints = new Set<string>();
    for (const r of rows) {
      if (r.kind !== "audit.prune") continue;
      try {
        const f = (JSON.parse(r.detail_json) as { finalHash?: unknown }).finalHash;
        if (typeof f === "string") checkpoints.add(f);
      } catch {
        // a checkpoint that cannot be read vouches for nothing
      }
    }
    let prev: string | null = null;
    for (const r of rows) {
      const linked = prev === null ? r.prev_hash === "" || checkpoints.has(r.prev_hash) : r.prev_hash === prev;
      if (!linked) return { ok: false, brokenAt: r.id, reason: "link" };
      const h = rowHash({ ts: r.ts, actorKind: r.actor_kind, actorId: r.actor_id, requestId: r.request_id, parentId: r.parent_id, kind: r.kind, target: r.target, outcome: r.outcome, detailJson: r.detail_json, prevHash: r.prev_hash });
      if (h !== r.hash) return { ok: false, brokenAt: r.id, reason: "hash" };
      prev = r.hash;
    }
    return { ok: true, rows: rows.length, lastHash: prev ?? "" };
  }

  /** The first entry of the chain, written once: it says how many earlier entries are outside it. */
  private ensureStart(): void {
    const chained = this.db.prepare("select 1 from audit_log where legacy = 0 limit 1").get();
    if (chained) return;
    this.db
      .transaction(() => {
        if (this.db.prepare("select 1 from audit_log where legacy = 0 limit 1").get()) return;
        const legacyRows = (this.db.prepare("select count(*) n from audit_log where legacy = 1").get() as { n: number }).n;
        this.insert({ kind: "audit.start", actorKind: "system", detail: { legacyRows } }, "system");
      })
      .immediate();
  }

  private append(i: RecordInput, actor: string): number {
    return this.db.transaction(() => this.insert(i, actor)).immediate();
  }

  /** Reads the last hash and writes the next entry; always called inside one immediate transaction. */
  private insert(i: RecordInput, actor: string): number {
    const prev = (this.db.prepare("select hash from audit_log where legacy = 0 order by id desc limit 1").get() as { hash: string } | undefined)?.hash ?? "";
    const ts = this.clock();
    const { json: detailJson, truncated } = redactDetail(i.detail ?? {});
    const ctx = currentRequest();
    const actorId = i.actorId ?? (ctx?.actorKind === i.actorKind ? (ctx.actorId ?? "") : "");
    const target = i.target ?? "";
    const outcome = i.outcome ?? "";
    const requestId = i.requestId ?? ctx?.requestId ?? null;
    const parentId = i.parentId ?? (i.requestId ? null : (ctx?.parentId ?? null));
    const hash = rowHash({ ts, actorKind: i.actorKind, actorId, requestId, parentId, kind: i.kind, target, outcome, detailJson, prevHash: prev });
    const info = this.db
      .prepare("insert into audit_log (ts, actor, kind, detail_json, actor_kind, actor_id, request_id, parent_id, target, outcome, truncated, legacy, prev_hash, hash) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .run(ts, actor, i.kind, detailJson, i.actorKind, actorId, requestId, parentId, target, outcome, truncated ? 1 : 0, prev, hash);
    return Number(info.lastInsertRowid);
  }
}
