import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { MeetingService } from "./service";
import type { MeetingStore } from "./store";

export interface MeetingRouteDeps {
  service: MeetingService;
  store: MeetingStore;
  /** Lets only the signed-in owner through, and only once the plugin is installed. */
  ownerGuard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** The meetings screen: what was attended, the notes, and a way to make it leave. What was said is only shown, never changed. */
export function registerMeetingRoutes(app: FastifyInstance, deps: MeetingRouteDeps): void {
  const { service, store, ownerGuard } = deps;

  app.get("/api/meetings", { onRequest: ownerGuard }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return {
      meetings: store.list(20).map((m) => {
        let host = "";
        try {
          host = new URL(m.url).hostname;
        } catch {
          /* not an address */
        }
        return { id: m.id, title: m.title, status: m.status, detail: m.detail, startsAt: m.startsAt, startedAt: m.startedAt, endedAt: m.endedAt, host, summary: m.summary, decisions: m.decisions, tasks: m.tasks, lines: store.lineCount(m.id) };
      }),
    };
  });

  app.post("/api/meetings/:id/leave", { onRequest: ownerGuard }, async (req, reply) => {
    const id = z.coerce.number().int().min(1).safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(400).send({ error: "Bad request" });
    if (!store.get(id.data)) return reply.code(404).send({ error: "No such meeting." });
    return { message: await service.leave(id.data) };
  });

  app.delete("/api/meetings/:id", { onRequest: ownerGuard }, async (req, reply) => {
    const id = z.coerce.number().int().min(1).safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(400).send({ error: "Bad request" });
    const m = store.get(id.data);
    if (!m) return reply.code(404).send({ error: "No such meeting." });
    if (m.status === "live" || m.status === "lobby" || m.status === "joining") return reply.code(409).send({ error: "It is in that meeting now. Make it leave first." });
    store.remove(id.data);
    return { ok: true };
  });
}
