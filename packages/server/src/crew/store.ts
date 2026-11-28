import type { Db } from "../db";

export type RouteKind = "mail" | "meeting";

export interface CrewWorker {
  id: string;
  name: string;
  role: string;
  brief: string;
  /** Names, or prefixes ending in *, of the tools this worker may use. */
  tools: string[];
  createdAt: number;
  lastAt: number;
}

interface Row {
  id: string;
  name: string;
  role: string;
  brief: string;
  tools_json: string;
  created_at: number;
  last_at: number;
}

const toWorker = (r: Row): CrewWorker => ({ id: r.id, name: r.name, role: r.role, brief: r.brief, tools: JSON.parse(r.tools_json) as string[], createdAt: r.created_at, lastAt: r.last_at });

/** A name as a folder-safe id: letters and digits only. */
export const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** The list of crew workers. Only who they are lives here; each worker's conversation and memory are in a database of its own. */
export class CrewStore {
  constructor(
    private db: Db,
    private clock: () => number = Date.now,
  ) {}

  hire(input: { name: string; role: string; brief: string; tools: string[] }): { ok: true; worker: CrewWorker } | { ok: false; error: string } {
    const id = slug(input.name);
    if (!id) return { ok: false, error: "A worker's name needs letters or digits." };
    if (this.find(input.name)) return { ok: false, error: `There is already a crew worker called ${input.name}.` };
    const now = this.clock();
    this.db.prepare("insert into crew_workers (id, name, role, brief, tools_json, created_at, last_at) values (?, ?, ?, ?, ?, ?, 0)").run(id, input.name.trim(), input.role.trim(), input.brief.trim(), JSON.stringify(input.tools), now);
    return { ok: true, worker: this.find(id)! };
  }

  /** By name or id, any case. */
  find(who: string): CrewWorker | undefined {
    const key = who.trim().toLowerCase();
    const r = this.db.prepare("select * from crew_workers where lower(name) = ? or id = ?").get(key, slug(who)) as Row | undefined;
    return r ? toWorker(r) : undefined;
  }

  list(): CrewWorker[] {
    return (this.db.prepare("select * from crew_workers order by created_at, id").all() as Row[]).map(toWorker);
  }

  setTools(id: string, tools: string[]): void {
    this.db.prepare("update crew_workers set tools_json = ? where id = ?").run(JSON.stringify(tools), id);
  }

  touch(id: string): void {
    this.db.prepare("update crew_workers set last_at = ? where id = ?").run(this.clock(), id);
  }

  remove(id: string): void {
    this.db.prepare("delete from crew_workers where id = ?").run(id);
    this.db.prepare("delete from crew_routes where worker = ?").run(id);
  }

  /** Who handles a mailbox or a meeting (a worker id), when it is not the assistant herself. */
  route(kind: RouteKind, key: string): string | undefined {
    return (this.db.prepare("select worker from crew_routes where kind = ? and key = ?").get(kind, key) as { worker: string } | undefined)?.worker;
  }

  /** Hands a mailbox or a meeting to a worker; null gives it back to the assistant. */
  setRoute(kind: RouteKind, key: string, worker: string | null): void {
    if (worker === null) this.db.prepare("delete from crew_routes where kind = ? and key = ?").run(kind, key);
    else this.db.prepare("insert into crew_routes (kind, key, worker) values (?, ?, ?) on conflict (kind, key) do update set worker = excluded.worker").run(kind, key, worker);
  }

  routes(): { kind: RouteKind; key: string; worker: string }[] {
    return this.db.prepare("select kind, key, worker from crew_routes order by kind, key").all() as { kind: RouteKind; key: string; worker: string }[];
  }
}
