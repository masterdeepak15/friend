import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { LockoutError } from "../auth";
import { HttpError } from "../http-error";
import type { MailAccounts } from "./accounts";

export interface MailRouteDeps {
  accounts: MailAccounts;
  /** Lets only the signed-in owner through, and only once the plugin is installed. */
  ownerGuard: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const Pin = z.string().min(1).max(32);
const email = z.email().max(254);
const host = z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/, "A server name such as imap.example.com");
const Imap = z.object({ host, port: z.number().int().min(1).max(65535), tls: z.boolean() }).strict();
const Smtp = z.object({ host, port: z.number().int().min(1).max(65535), secure: z.boolean() }).strict();
const Sender = z.string().min(3).max(254).regex(/^(@[A-Za-z0-9.-]+|[^\s@]+@[A-Za-z0-9.-]+)$/, "An address, or @domain for a whole domain");
const Ladder = z.object({ send: z.enum(["ask", "auto"]), reply: z.enum(["ask", "auto"]), forward: z.enum(["ask", "auto"]) }).strict();
const Base = { name: z.string().min(1).max(60), address: email, imap: Imap, smtp: Smtp, username: z.string().min(1).max(254), owners: z.array(email).max(10), systems: z.array(Sender).max(20) };

const failure = (reply: FastifyReply, e: unknown): FastifyReply => {
  if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
  if (e instanceof LockoutError) return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: "Too many wrong PINs. Wait a moment." });
  throw e;
};

/** The routes that manage mailboxes. Passwords go in, never come out; everything that changes something needs the PIN. */
export function registerMailRoutes(app: FastifyInstance, deps: MailRouteDeps): void {
  const { accounts, ownerGuard } = deps;
  const bad = (reply: FastifyReply, e: z.ZodError) => reply.code(400).send({ error: e.issues[0]?.message ? `${e.issues[0].path.join(".") || "request"}: ${e.issues[0].message}` : "Bad request" });

  app.get("/api/mail/accounts", { onRequest: ownerGuard }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return { accounts: accounts.list() };
  });

  app.post("/api/mail/accounts", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ ...Base, password: z.string().min(1).max(500), pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const { password, pin, ...input } = body.data;
    try {
      return { account: await accounts.add(input, password, pin, req.ip) };
    } catch (e) {
      return failure(reply, e);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/mail/accounts/:id", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ name: Base.name.optional(), address: Base.address.optional(), imap: Imap.optional(), smtp: Smtp.optional(), username: Base.username.optional(), owners: Base.owners.optional(), systems: Base.systems.optional(), enabled: z.boolean().optional(), password: z.string().min(1).max(500).optional(), pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    const { password, pin, ...patch } = body.data;
    try {
      return { account: await accounts.update(Number(req.params.id), patch as Parameters<MailAccounts["update"]>[1], password, pin, req.ip) };
    } catch (e) {
      return failure(reply, e);
    }
  });

  app.put<{ Params: { id: string } }>("/api/mail/accounts/:id/ladder", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ ladder: Ladder, pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return bad(reply, body.error);
    try {
      return { account: await accounts.setLadder(Number(req.params.id), body.data.ladder, body.data.pin, req.ip) };
    } catch (e) {
      return failure(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/api/mail/accounts/:id/test", { onRequest: ownerGuard }, async (req, reply) => {
    try {
      return await accounts.test(Number(req.params.id));
    } catch (e) {
      return failure(reply, e);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/mail/accounts/:id", { onRequest: ownerGuard }, async (req, reply) => {
    const body = z.object({ pin: Pin }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN." });
    try {
      await accounts.remove(Number(req.params.id), body.data.pin, req.ip);
      return { ok: true };
    } catch (e) {
      return failure(reply, e);
    }
  });
}
