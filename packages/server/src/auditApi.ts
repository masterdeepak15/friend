import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Audit } from "./audit";
import { type AuditFilter, type AuditQuery } from "./auditQuery";
import { LockoutError, type Auth } from "./auth";
import type { AuditConfig } from "./config";

/** The short-lived tokens that open the audit area after the PIN. Kept in memory only: a restart locks it again. */
export class UnlockStore {
  private tokens = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  issue(minutes: number): { token: string; expiresAt: number } {
    const t = this.now();
    for (const [k, v] of this.tokens) if (v < t) this.tokens.delete(k);
    const token = randomBytes(32).toString("hex");
    const expiresAt = t + minutes * 60_000;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (exp === undefined) return false;
    if (exp < this.now()) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
}

export interface AuditApiDeps {
  app: FastifyInstance;
  auth: Auth;
  audit: Audit;
  query: AuditQuery;
  config: () => AuditConfig;
  cookieName: string;
  unlocks?: UnlockStore;
}

const ACTOR = z.enum(["owner", "assistant", "worker", "system", "outsider"]);
const GROUP = z.enum(["approvals", "tools", "workers", "logins", "messages", "settings", "system", "other"]);
const OUTCOME = z.enum(["started", "done", "refused", "failed", "waiting"]);
const int = z.coerce.number().int().min(0);
export const FilterQuery = z
  .object({
    from: int.optional(),
    to: int.optional(),
    actorKind: ACTOR.optional(),
    actorId: z.string().max(120).optional(),
    group: GROUP.optional(),
    outcome: OUTCOME.optional(),
    q: z.string().max(200).optional(),
    requestId: z.string().max(80).optional(),
    before: int.optional(),
    limit: int.max(100_000).optional(),
  })
  .strict();

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** A request that came through a proxy or a tunnel looks like it came from this PC; these headers give it away. */
const PROXIED = ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip", "true-client-ip"];

/** Whether the owner's PIN may be given with the request itself (the command line, on this PC, with no proxy in between). */
export const directPinAllowed = (ip: string, headers: Record<string, unknown>): boolean => LOOPBACK.has(ip) && !PROXIED.some((h) => headers[h] !== undefined);

/** The audit routes. They only read: no route changes or removes an entry. */
export function registerAuditRoutes(d: AuditApiDeps): void {
  const unlocks = d.unlocks ?? new UnlockStore();
  const { app } = d;

  const pinOk = async (pin: string, ip: string, reply: FastifyReply): Promise<boolean> => {
    try {
      if (await d.auth.verifyPin(pin, ip)) return true;
      reply.code(403).send({ error: "Incorrect PIN" });
    } catch (e) {
      if (e instanceof LockoutError) reply.code(429).send({ error: e.message });
      else throw e;
    }
    return false;
  };

  /** Lets a request through when it is the signed-in owner with the audit area open, or this PC's command line giving the PIN. */
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const direct = req.headers["x-owner-pin"];
    if (typeof direct === "string" && directPinAllowed(req.ip, req.headers)) {
      if (!(await pinOk(direct, req.ip, reply))) return;
      return;
    }
    const session = req.cookies?.[d.cookieName];
    if (!(session && d.auth.resolveSession(session))) return void reply.code(401).send({ error: "Unauthorized" });
    const token = req.headers["x-audit-unlock"];
    if (!unlocks.valid(typeof token === "string" ? token : undefined)) return void reply.code(403).send({ error: "locked" });
  };

  const read = (route: string, req: FastifyRequest): void => {
    try {
      d.audit.record({ kind: "audit.read", actorKind: "owner", actorId: "owner", target: route, outcome: "done", detail: { route, query: req.query ?? {} } });
    } catch {
      // reading is not refused because the note of it could not be written
    }
  };

  const filters = (req: FastifyRequest, reply: FastifyReply): AuditFilter | null => {
    const p = FilterQuery.safeParse(req.query ?? {});
    if (!p.success) {
      reply.code(400).send({ error: `Bad filter: ${p.error.issues[0]?.path.join(".") ?? "query"}` });
      return null;
    }
    return Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined)) as AuditFilter;
  };

  app.post("/api/audit/unlock", async (req, reply) => {
    const session = req.cookies?.[d.cookieName];
    if (!(session && d.auth.resolveSession(session))) return reply.code(401).send({ error: "Unauthorized" });
    const pin = (req.body as { pin?: unknown } | null)?.pin;
    if (typeof pin !== "string" || !pin) return reply.code(400).send({ error: "PIN required" });
    if (!(await pinOk(pin, req.ip, reply))) return;
    const t = unlocks.issue(d.config().unlockMinutes);
    try {
      d.audit.record({ kind: "audit.unlock", actorKind: "owner", actorId: "owner", outcome: "done", detail: { minutes: d.config().unlockMinutes, ip: req.ip } });
    } catch {
      // the unlock stands
    }
    return t;
  });

  app.get("/api/audit", { onRequest: guard }, async (req, reply) => {
    const f = filters(req, reply);
    if (!f) return;
    read("/api/audit", req);
    return { rows: d.query.search(f), counts: d.query.counts(f) };
  });

  app.get("/api/audit/request/:id", { onRequest: guard }, async (req) => {
    read("/api/audit/request", req);
    return { tree: d.query.tree((req.params as { id: string }).id.slice(0, 80)) };
  });

  app.get("/api/audit/attention", { onRequest: guard }, async (req, reply) => {
    const hours = Number((req.query as { hours?: string }).hours ?? 24);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) return reply.code(400).send({ error: "Bad filter: hours" });
    read("/api/audit/attention", req);
    return { rows: d.query.attention(Date.now() - hours * 3600_000) };
  });

  app.get("/api/audit/verify", { onRequest: guard }, async (req) => {
    read("/api/audit/verify", req);
    return d.audit.verify();
  });

  app.get("/api/audit/status", { onRequest: guard }, async (req) => {
    read("/api/audit/status", req);
    const last = d.audit.last();
    const seal = d.query.search({ q: "audit.seal", limit: 50 }).find((r) => r.kind === "audit.seal");
    return { rows: d.query.counts({}).total, lastId: last?.id ?? null, lastSeal: seal ? { at: seal.ts, text: seal.detail.text ?? null } : null, keepDays: d.config().keepDays, workers: d.query.workers() };
  });
}
