import { PcPermissions } from "@friend/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LockoutError } from "../auth";
import { HttpError } from "../http-error";
import type { PcService } from "./service";

export interface PcRouteDeps {
  svc: PcService;
  /** Lets only the signed-in owner through. */
  ownerGuard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** A few calls a minute per address: the PC-side endpoints are open to the network, so they are rate limited. */
function limiter(max: number, windowMs: number) {
  const seen = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const hits = (seen.get(key) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      seen.set(key, hits);
      return false;
    }
    hits.push(now);
    seen.set(key, hits);
    if (seen.size > 5000) seen.clear();
    return true;
  };
}

const Pin = z.string().min(1).max(32);
const Code = /^[A-Za-z0-9-]{4,20}$/;
const failure = (reply: FastifyReply, e: unknown): FastifyReply => {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof LockoutError) return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: "Too many wrong PINs. Wait a moment." });
  throw e;
};

/** The routes of the Windows PCs: the PC signs in without a cookie (rate limited, and proven by the PKCE secret); the owner manages the list. */
export function registerPcRoutes(app: FastifyInstance, deps: PcRouteDeps): void {
  const { svc, ownerGuard } = deps;
  const open = limiter(30, 60_000);
  const gate = (req: FastifyRequest, reply: FastifyReply): boolean => {
    reply.header("cache-control", "no-store");
    if (open(req.ip)) return true;
    void reply.code(429).header("retry-after", 30).send({ error: "Too many requests" });
    return false;
  };

  // ---- the PC (no cookie) ----
  app.post("/api/pc/enroll/start", async (req, reply) => {
    if (!gate(req, reply)) return reply;
    const body = z.object({ enrollmentId: z.string().min(10).max(64), challenge: z.string().length(43), os: z.string().max(80), host: z.string().max(80) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Bad request" });
    const r = svc.start(body.data, req.ip);
    return "error" in r ? reply.code(400).send(r) : { ...r, verifyPath: `/pc/approve?code=${r.userCode}` };
  });
  app.post("/api/pc/enroll/token", async (req, reply) => {
    if (!gate(req, reply)) return reply;
    const body = z.object({ deviceCode: z.string().min(20).max(80), verifier: z.string().min(20).max(120) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Bad request" });
    const r = svc.token(body.data);
    if ("pending" in r) return reply.code(202).send(r);
    return "error" in r ? reply.code(400).send(r) : r;
  });
  app.post("/api/pc/token/refresh", async (req, reply) => {
    if (!gate(req, reply)) return reply;
    const body = z.object({ refresh: z.string().min(20).max(120) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Bad request" });
    const r = svc.refresh(body.data.refresh, req.ip);
    return "error" in r ? reply.code(401).send(r) : r;
  });

  // ---- the owner ----
  app.get("/api/pc", { onRequest: ownerGuard }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return { pcs: svc.list() };
  });
  app.post("/api/pc", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(60), permissions: PcPermissions.optional(), pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Give the PC a name and enter your PIN." });
    try {
      return await svc.add({ name: body.data.name, permissions: body.data.permissions }, body.data.pin, req.ip);
    } catch (e) {
      return failure(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>("/api/pc/:id/enrollment", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN." });
    try {
      return await svc.reissue(Number(req.params.id), body.data.pin, req.ip);
    } catch (e) {
      return failure(reply, e);
    }
  });
  app.get<{ Params: { code: string } }>("/api/pc/enroll/:code", { onRequest: ownerGuard }, async (req, reply) => {
    if (!Code.test(req.params.code)) return reply.code(404).send({ error: "That code is not valid or has expired." });
    const found = svc.lookup(req.params.code);
    return found ?? reply.code(404).send({ error: "That code is not valid or has expired." });
  });
  app.post<{ Params: { code: string } }>("/api/pc/enroll/:code/approve", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ permissions: PcPermissions.optional(), name: z.string().min(1).max(60).optional(), pin: Pin }).strict().safeParse(req.body);
    if (!body.success || !Code.test(req.params.code)) return reply.code(400).send({ error: "Enter your PIN." });
    try {
      return await svc.approve(req.params.code, { permissions: body.data.permissions, name: body.data.name }, body.data.pin, req.ip);
    } catch (e) {
      return failure(reply, e);
    }
  });
  app.put<{ Params: { id: string } }>("/api/pc/:id/permissions", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ permissions: PcPermissions, pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Those permissions are not valid, or the PIN is missing." });
    try {
      return { pc: await svc.setPermissions(Number(req.params.id), body.data.permissions, body.data.pin, req.ip) };
    } catch (e) {
      return failure(reply, e);
    }
  });
  app.post<{ Params: { id: string } }>("/api/pc/:id/revoke", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN." });
    try {
      await svc.revoke(Number(req.params.id), body.data.pin, req.ip);
      return { ok: true };
    } catch (e) {
      return failure(reply, e);
    }
  });
  app.delete<{ Params: { id: string } }>("/api/pc/:id", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN." });
    try {
      await svc.remove(Number(req.params.id), body.data.pin, req.ip);
      return { ok: true };
    } catch (e) {
      return failure(reply, e);
    }
  });
}
