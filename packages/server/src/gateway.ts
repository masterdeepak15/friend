import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ClientMsg, type ServerMsg } from "@friend/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Audit } from "./audit";
import { LockoutError, type Auth, type Device, type Session } from "./auth";
import type { Config } from "./config";

export const COOKIE_NAME = "friend_session";
export const MAX_FRAME_BYTES = 64 * 1024;

export interface ClientConn {
  send(m: ServerMsg): void;
  close(code?: number, reason?: string): void;
  readonly ip: string;
}

export interface GatewayDeps {
  config: Config;
  auth: Auth;
  audit: Audit;
  webDir?: string;
  onClientMessage: (session: Session, msg: ClientMsg, conn: ClientConn) => void;
  onClientConnect?: (session: Session, conn: ClientConn) => void | (() => void);
  onDeviceConnect: (device: Device, ws: WebSocket) => void;
  onLock?: () => void;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const SetupBody = z.object({
  password: z.string().min(1),
  pin: z.string().min(1),
  assistantName: z.string().min(1),
});

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createGateway(deps: GatewayDeps) {
  const { config, auth, audit } = deps;
  const app: FastifyInstance = Fastify({ trustProxy: config.trustProxy, logger: false, bodyLimit: 64 * 1024 });
  app.register(fastifyCookie);

  const isSecure = (req: FastifyRequest) => req.protocol === "https";

  app.get("/api/state", async () => ({ hasOwner: auth.hasOwner() }));

  app.post("/api/setup", async (req, reply) => {
    const remote = req.socket.remoteAddress ?? "";
    const forwarded = req.headers["x-forwarded-for"] || req.headers["forwarded"] || req.headers["x-real-ip"];
    if (auth.hasOwner() || !LOOPBACK.has(remote) || forwarded) {
      audit.log("anonymous", "setup.refused", { ip: remote });
      return reply.code(403).send({ error: "Setup is not available" });
    }
    const body = SetupBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      await auth.setupOwner(body.data);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  app.post("/api/login", async (req, reply) => {
    const body = z.object({ password: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      const { token, expiresAt } = await auth.login(body.data.password, req.ip);
      reply.setCookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: isSecure(req),
        path: "/",
        expires: new Date(expiresAt),
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof LockoutError) {
        return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: e.message });
      }
      return reply.code(401).send({ error: "Invalid credentials" });
    }
  });

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) auth.revokeSession(token);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.post("/api/lock", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token || !auth.resolveSession(token)) return reply.code(401).send({ error: "Unauthorized" });
    auth.revokeAll();
    deps.onLock?.();
    return { ok: true };
  });

  if (deps.webDir && existsSync(deps.webDir)) {
    app.register(fastifyStatic, { root: deps.webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "Not found" });
    });
  }

  // ---- WebSockets ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const o = new URL(origin);
      if (o.host === req.headers.host) return true;
      if (config.allowedOrigins.includes(origin)) return true;
      if (config.publicUrl && new URL(config.publicUrl).origin === o.origin) return true;
    } catch {
      /* fall through */
    }
    return false;
  };

  const clientIp = (req: IncomingMessage): string => {
    const fwd = config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
    return fwd || req.socket.remoteAddress || "unknown";
  };

  function handleClient(ws: WebSocket, req: IncomingMessage) {
    if (!originAllowed(req)) {
      audit.log("anonymous", "ws.origin_refused", { origin: req.headers.origin });
      return ws.close(4403, "origin");
    }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return ws.close(4401, "unauthorized");

    const conn: ClientConn = {
      ip: clientIp(req),
      send: (m) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const dispose = deps.onClientConnect?.(session, conn);
    ws.on("close", () => dispose?.());
    ws.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return conn.send({ type: "error", message: "Invalid JSON" });
      }
      const parsed = ClientMsg.safeParse(json);
      if (!parsed.success) return conn.send({ type: "error", message: "Unknown or invalid message" });
      if (!auth.resolveSession(token!)) return ws.close(4401, "unauthorized");
      try {
        deps.onClientMessage(session, parsed.data, conn);
      } catch (e) {
        audit.log("system", "ws.handler_error", { message: (e as Error).message });
        conn.send({ type: "error", message: "Internal error" });
      }
    });
  }

  function handleDevice(ws: WebSocket, req: IncomingMessage) {
    const header = String(req.headers.authorization ?? "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const device = token ? auth.resolveDevice(token) : null;
    if (!device) {
      audit.log("anonymous", "device.refused", { ip: clientIp(req) });
      return ws.close(4401, "unauthorized");
    }
    deps.onDeviceConnect(device, ws);
  }

  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/ws" && path !== "/device") return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => {});
      if (path === "/ws") handleClient(ws, req);
      else handleDevice(ws, req);
    });
  });

  return {
    app,
    async listen(): Promise<{ port: number }> {
      await app.listen({ host: config.bind, port: config.port });
      const addr = app.server.address();
      return { port: typeof addr === "object" && addr ? addr.port : config.port };
    },
    async close(): Promise<void> {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await app.close();
    },
  };
}
