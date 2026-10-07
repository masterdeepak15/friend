import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ClientMsg, type ServerMsg } from "@friend/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { Audit } from "./audit";
import { LockoutError, type Auth, type Device, type Session } from "./auth";
import { RateLimiter } from "./ratelimit";
import type { Config } from "./config";

export const COOKIE_NAME = "friend_session";
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_DEVICE_FRAME_BYTES = 8 * 1024 * 1024;

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
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
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
  // One trusted proxy hop: the address that proxy appended is used, never entries a client prepended.
  const app: FastifyInstance = Fastify({ trustProxy: config.trustProxy ? 1 : false, logger: false, bodyLimit: 64 * 1024 });
  app.register(fastifyCookie);

  const hostOf = (header: string | undefined): string => {
    const h = (header ?? "").trim().toLowerCase();
    if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:port
    return h.split(":")[0] ?? "";
  };
  const publicHost = config.publicUrl ? new URL(config.publicUrl).hostname.toLowerCase() : null;
  const extraHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
  /** Blocks DNS rebinding: an attacker's domain can point at this PC but cannot be an IP literal or a configured name. */
  const hostAllowed = (header: string | undefined): boolean => {
    const h = hostOf(header);
    if (!h) return false;
    const bare = h.replace(/^\[|\]$/g, "");
    return LOOPBACK_NAMES.has(h) || isIP(bare) !== 0 || h === publicHost || extraHosts.has(h);
  };
  app.addHook("onRequest", async (req, reply) => {
    if (!hostAllowed(req.headers.host)) {
      audit.log("anonymous", "host.refused", { host: String(req.headers.host).slice(0, 100) });
      return reply.code(421).send({ error: "Unknown host" });
    }
  });

  const isSecure = (req: FastifyRequest) => req.protocol === "https";

  app.get("/api/state", async () => ({ hasOwner: auth.hasOwner() }));

  app.post("/api/setup", async (req, reply) => {
    const remote = req.socket.remoteAddress ?? "";
    const forwarded = req.headers["x-forwarded-for"] || req.headers["forwarded"] || req.headers["x-real-ip"];
    // A reverse proxy on this PC makes remote visitors look like loopback, so the Host must also be a local name.
    if (auth.hasOwner() || !LOOPBACK.has(remote) || forwarded || !LOOPBACK_NAMES.has(hostOf(req.headers.host))) {
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

  const pairLimiter = new RateLimiter(Date.now);
  app.post("/api/pair", async (req, reply) => {
    const body = z.object({ code: z.string().min(1).max(64), name: z.string().min(1).max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    const key = `pair:${req.ip}`;
    try {
      pairLimiter.check(key);
    } catch (e) {
      const ms = e instanceof LockoutError ? e.retryAfterMs : 60_000;
      return reply.code(429).header("retry-after", Math.ceil(ms / 1000)).send({ error: "Too many attempts" });
    }
    try {
      const token = auth.redeemPairCode(body.data.code, body.data.name);
      pairLimiter.reset(key);
      return { token };
    } catch {
      pairLimiter.fail(key);
      return reply.code(400).send({ error: "Invalid or expired pairing code" });
    }
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
  // Devices send whole tool results (file contents, command output), which can be much larger than a chat frame.
  const deviceWss = new WebSocketServer({ noServer: true, maxPayload: MAX_DEVICE_FRAME_BYTES });

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
    // The last entry is the one our own proxy appended; earlier entries are client-controlled.
    const fwd = config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)?.trim() : "";
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
    if (!hostAllowed(req.headers.host)) {
      audit.log("anonymous", "host.refused", { host: String(req.headers.host).slice(0, 100) });
      socket.write("HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    (path === "/device" ? deviceWss : wss).handleUpgrade(req, socket, head, (ws) => {
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
      for (const c of [...wss.clients, ...deviceWss.clients]) c.terminate();
      wss.close();
      deviceWss.close();
      await app.close();
    },
  };
}
