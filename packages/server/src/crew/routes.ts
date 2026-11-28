import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Crew } from "./crew";

export interface CrewRouteDeps {
  crew: Crew;
  /** Lets only the signed-in owner through. */
  ownerGuard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const Body = z.object({ kind: z.enum(["mail", "meeting"]), key: z.string().min(1).max(40), worker: z.string().min(1).max(64).nullable() }).strict();

/** Who handles each mailbox and meeting: the assistant (nobody listed) or a crew worker. The owner can change it from the mailbox list. */
export function registerCrewRoutes(app: FastifyInstance, deps: CrewRouteDeps): void {
  const { crew, ownerGuard } = deps;

  app.get("/api/crew/routes", { onRequest: ownerGuard }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return { workers: crew.list().map((w) => ({ id: w.id, name: w.name, role: w.role })), routes: crew.routes() };
  });

  app.put("/api/crew/routes", { onRequest: ownerGuard }, async (req, reply) => {
    const body = Body.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Say which mailbox or meeting, and which worker (or null for the assistant)." });
    const { kind, key, worker } = body.data;
    const r = crew.assignKey(kind, key, worker);
    return r.ok ? { ok: true } : reply.code(404).send({ error: r.error });
  });
}
