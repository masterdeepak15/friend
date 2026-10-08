import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ClientMsg, type ServerMsg } from "@friend/protocol";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
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
import { HttpError } from "./http-error";

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
  /** Whether speech is currently available (the voice sidecar is up). */
  voiceAvailable?: () => boolean;
  /** Handles one recorded utterance; resolves with what was heard ("" when nothing intelligible). */
  onVoiceUtterance?: (session: Session, audio: Buffer, mime: string, ip: string) => Promise<{ text: string }>;
  /** Teaching Friend the owner's voice; the routes answer 503 without it. */
  voiceEnroll?: VoiceEnrollApi;
  /** Managing plugins from the owner's screen; the routes answer 503 without it. */
  plugins?: PluginsApi;
  /** Managing connectors from the owner's screen; the routes answer 503 without it. */
  connectors?: ConnectorsApi;
  /** Changing settings from the owner's screen; the routes answer 503 without it. */
  settings?: SettingsApi;
  /** Says a short sentence in the named voice and returns it as a WAV recording, so the owner can hear a voice before choosing it. */
  voicePreview?: (voice: string) => Promise<Buffer>;
  /** What the conversation and schedule panels show; the routes answer 503 without it. */
  data?: DataApi;
  /** A picture arrived for a camera request: "unknown" when nobody is waiting for that id, "invalid" when it is not a JPEG. */
  onCameraFrame?: (id: string, jpeg: Buffer) => "ok" | "unknown" | "invalid";
}

export const MAX_CAMERA_FRAME_BYTES = 2 * 1024 * 1024;

/** What the settings routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface SettingsApi {
  get(): unknown;
  /** Needs the owner's PIN: a setting can change which program runs or where the owner's words are sent. */
  update(patch: unknown, pin: string | undefined, ip: string): Promise<unknown>;
}

/** Read-only data for the owner's side panels (the conversation and the schedule). */
export interface DataApi {
  history(): unknown;
  tasks(): unknown;
}

/** What the connector routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface ConnectorsApi {
  list(): unknown;
  /** Adds a connector and switches it on. Needs the owner's PIN: it starts a program or reaches a service. */
  add(input: unknown, pin: string, ip: string): Promise<unknown>;
  /** Switching on needs the PIN; switching off does not. */
  setEnabled(id: string, enabled: boolean, pin: string | undefined, ip: string): Promise<unknown>;
  reload(id: string): Promise<unknown>;
  remove(id: string): Promise<void>;
}

/** What the plugin routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface PluginsApi {
  list(): unknown;
  /** Installs a bundled plugin; needs the owner's PIN because it adds capabilities. */
  install(id: string, pin: string, ip: string): Promise<{ id: string; upgraded: boolean }>;
  /** Switching on needs the PIN; switching off does not. */
  setEnabled(id: string, enabled: boolean, pin: string | undefined, ip: string): Promise<void>;
  remove(id: string): void;
  /** Reads every plugin from disk again and checks it (after a plugin was changed by hand or written by the AI). */
  reload(): void;
}

/** What the enrollment routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface VoiceEnrollApi {
  state(): { enrolled: boolean; samples: number; min: number; max: number };
  sample(audio: Buffer, mime: string): Promise<{ count: number; note: string | null }>;
  finish(pin: string, ip: string): Promise<{ samples: number }>;
  cancel(): void;
  remove(pin: string, ip: string): Promise<void>;
}

export const MAX_UTTERANCE_BYTES = 4 * 1024 * 1024;

/** Allows `max` hits per key within a sliding window. Keys that have gone quiet are forgotten. */
export class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private clock: () => number = Date.now) {}

  allow(key: string): boolean {
    const now = this.clock();
    if (this.hits.size > 256) this.prune(now);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  size(): number {
    return this.hits.size;
  }

  private prune(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
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
  const options: FastifyServerOptions = {
    trustProxy: config.trustProxy ? (_addr: string, hop: number) => hop < 1 : false,
    logger: false,
    bodyLimit: 64 * 1024,
    forceCloseConnections: true, // shutdown must not wait for idle keep-alive connections
  };
  const app: FastifyInstance = Fastify(options);
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

  // Recorded audio arrives as a raw body. Auth, rate limit and availability are checked in onRequest,
  // i.e. before the body is read, so a rejected request costs no transcription work.
  app.addContentTypeParser(/^audio\//, { parseAs: "buffer", bodyLimit: MAX_UTTERANCE_BYTES }, (_req, body, done) => done(null, body));
  const utteranceWindow = new SlidingWindow(10, 10_000);
  app.post(
    "/api/voice/utterance",
    {
      bodyLimit: MAX_UTTERANCE_BYTES,
      onRequest: async (req, reply) => {
        const token = req.cookies[COOKIE_NAME];
        const session = token ? auth.resolveSession(token) : null;
        if (!session) return reply.code(401).send({ error: "Unauthorized" });
        if (!utteranceWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
        if (!deps.onVoiceUtterance || !(deps.voiceAvailable?.() ?? false)) return reply.code(503).send({ error: "Voice is not available" });
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "Send the recording as audio/*" });
      if (body.length === 0) return reply.code(400).send({ error: "Empty recording" });
      // the session may have ended (emergency lock, logout) since onRequest: never run a turn for a dead session
      const token = req.cookies[COOKIE_NAME];
      const session = token ? auth.resolveSession(token) : null;
      if (!session) return reply.code(401).send({ error: "Unauthorized" });
      try {
        return await deps.onVoiceUtterance!(session, body, String(req.headers["content-type"] ?? "audio/webm"), req.ip);
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
        audit.log("owner", "voice.utterance_failed", { message: (e as Error).message }); // raw detail stays in the audit log
        return reply.code(502).send({ error: "Speech recognition failed. Try again." });
      }
    },
  );

  // ---- camera pictures: uploaded over HTTP because the WebSocket frame limit protects chat ----
  app.addContentTypeParser("image/jpeg", { parseAs: "buffer", bodyLimit: MAX_CAMERA_FRAME_BYTES }, (_req, body, done) => done(null, body));
  const cameraWindow = new SlidingWindow(10, 10_000);
  app.post<{ Params: { id: string } }>(
    "/api/camera/frame/:id",
    {
      bodyLimit: MAX_CAMERA_FRAME_BYTES,
      onRequest: async (req, reply) => {
        const token = req.cookies[COOKIE_NAME];
        const session = token ? auth.resolveSession(token) : null;
        if (!session) return reply.code(401).send({ error: "Unauthorized" });
        if (!cameraWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
        if (!deps.onCameraFrame) return reply.code(503).send({ error: "Camera is not available" });
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "Send the picture as image/jpeg" });
      const out = deps.onCameraFrame!(req.params.id, body);
      if (out === "unknown") return reply.code(404).send({ error: "Nobody is waiting for that picture" });
      if (out === "invalid") return reply.code(400).send({ error: "That is not a JPEG picture" });
      return { ok: true };
    },
  );

  // ---- plugins (owner session only) ----
  const pluginWindow = new SlidingWindow(30, 60_000);
  const pluginGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!pluginWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.plugins) return reply.code(503).send({ error: "Plugins are not available" });
  };
  const pluginError = (reply: FastifyReply, e: unknown, what: string) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    audit.log("owner", "plugin.failed", { what, message: (e as Error).message }); // raw detail stays in the audit log
    return reply.code(500).send({ error: "That did not work. Try again." });
  };
  app.get("/api/plugins", { onRequest: pluginGuard }, async () => deps.plugins!.list());
  app.post("/api/plugins/install", { onRequest: pluginGuard }, async (req, reply) => {
    const body = z.object({ id: z.string().max(64), pin: z.string().min(1).max(32) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose a plugin and enter your PIN" });
    try {
      return await deps.plugins!.install(body.data.id, body.data.pin, req.ip);
    } catch (e) {
      return pluginError(reply, e, "install");
    }
  });
  app.post<{ Params: { id: string } }>("/api/plugins/:id/enabled", { onRequest: pluginGuard }, async (req, reply) => {
    const body = z.object({ enabled: z.boolean(), pin: z.string().min(1).max(32).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      await deps.plugins!.setEnabled(req.params.id, body.data.enabled, body.data.pin, req.ip);
      return { ok: true };
    } catch (e) {
      return pluginError(reply, e, "enable");
    }
  });
  app.post("/api/plugins/reload", { onRequest: pluginGuard }, async (_req, reply) => {
    try {
      deps.plugins!.reload();
      return deps.plugins!.list();
    } catch (e) {
      return pluginError(reply, e, "reload");
    }
  });
  app.delete<{ Params: { id: string } }>("/api/plugins/:id", { onRequest: pluginGuard }, async (req, reply) => {
    try {
      deps.plugins!.remove(req.params.id);
      return { ok: true };
    } catch (e) {
      return pluginError(reply, e, "remove");
    }
  });

  // ---- connectors (owner session only) ----
  const connectorWindow = new SlidingWindow(30, 60_000);
  const connectorGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!connectorWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.connectors) return reply.code(503).send({ error: "Connectors are not available" });
  };
  const connectorError = (reply: FastifyReply, e: unknown, what: string) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    audit.log("owner", "connector.failed", { what, message: (e as Error).message }); // raw detail stays in the audit log
    return reply.code(500).send({ error: "That did not work. Try again." });
  };
  app.get("/api/connectors", { onRequest: connectorGuard }, async () => deps.connectors!.list());
  app.post("/api/connectors", { onRequest: connectorGuard }, async (req, reply) => {
    const body = z.object({ pin: z.string().min(1).max(32), connector: z.record(z.string(), z.unknown()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Fill in the connector and enter your PIN" });
    try {
      return await deps.connectors!.add(body.data.connector, body.data.pin, req.ip);
    } catch (e) {
      return connectorError(reply, e, "add");
    }
  });
  app.post<{ Params: { id: string } }>("/api/connectors/:id/enabled", { onRequest: connectorGuard }, async (req, reply) => {
    const body = z.object({ enabled: z.boolean(), pin: z.string().min(1).max(32).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      return await deps.connectors!.setEnabled(req.params.id, body.data.enabled, body.data.pin, req.ip);
    } catch (e) {
      return connectorError(reply, e, "enable");
    }
  });
  app.post<{ Params: { id: string } }>("/api/connectors/:id/reload", { onRequest: connectorGuard }, async (req, reply) => {
    try {
      return await deps.connectors!.reload(req.params.id);
    } catch (e) {
      return connectorError(reply, e, "reload");
    }
  });
  app.delete<{ Params: { id: string } }>("/api/connectors/:id", { onRequest: connectorGuard }, async (req, reply) => {
    try {
      await deps.connectors!.remove(req.params.id);
      return { ok: true };
    } catch (e) {
      return connectorError(reply, e, "remove");
    }
  });

  // ---- settings (owner session only) ----
  const settingsWindow = new SlidingWindow(30, 60_000);
  const settingsGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!settingsWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.settings) return reply.code(503).send({ error: "Settings are not available" });
  };
  app.get("/api/settings", { onRequest: settingsGuard }, async () => deps.settings!.get());
  app.put("/api/settings", { onRequest: settingsGuard }, async (req, reply) => {
    const body = z.object({ pin: z.string().min(1).max(32).optional(), settings: z.record(z.string(), z.unknown()) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN to save settings" });
    try {
      return await deps.settings!.update(body.data.settings, body.data.pin, req.ip);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      audit.log("owner", "settings.failed", { message: (e as Error).message }); // raw detail stays in the audit log
      return reply.code(500).send({ error: "That did not work. Try again." });
    }
  });

  // ---- hearing a voice before choosing it (owner session only) ----
  const previewWindow = new SlidingWindow(12, 60_000);
  app.post("/api/voice/preview", {
    bodyLimit: 1024,
    onRequest: async (req, reply) => {
      const token = req.cookies[COOKIE_NAME];
      const session = token ? auth.resolveSession(token) : null;
      if (!session) return reply.code(401).send({ error: "Unauthorized" });
      if (!previewWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
      if (!deps.voicePreview) return reply.code(503).send({ error: "Voice is not available" });
    },
  }, async (req, reply) => {
    const body = z.object({ voice: z.string().min(1).max(80) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose a voice" });
    try {
      const wav = await deps.voicePreview!(body.data.voice);
      return reply.type("audio/wav").send(wav);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      audit.log("owner", "voice.preview_failed", { message: (e as Error).message });
      return reply.code(502).send({ error: "Could not play that voice. The first time it needs internet." });
    }
  });

  // ---- conversation and schedule panels (owner session only, read-only) ----
  const dataWindow = new SlidingWindow(60, 60_000);
  const dataGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!dataWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 5).send({ error: "Too many requests" });
    if (!deps.data) return reply.code(503).send({ error: "Not available" });
  };
  app.get("/api/history", { onRequest: dataGuard }, async () => deps.data!.history());
  app.get("/api/tasks", { onRequest: dataGuard }, async () => deps.data!.tasks());

  // ---- voice enrollment (owner session only) ----
  const enrollWindow = new SlidingWindow(30, 60_000);
  const PinBody = z.object({ pin: z.string().min(1).max(32) });
  /** Session check, rate limit and availability for every enrollment route. */
  const enrollGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!enrollWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.voiceEnroll) return reply.code(503).send({ error: "Voice is not available" });
  };
  const enrollError = (reply: FastifyReply, e: unknown, what: string) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    audit.log("owner", "voice.enroll_failed", { what, message: (e as Error).message }); // raw detail stays in the audit log
    return reply.code(502).send({ error: "Voice enrollment failed. Try again." });
  };
  app.get("/api/voice/enroll", { onRequest: enrollGuard }, async () => deps.voiceEnroll!.state());
  app.post(
    "/api/voice/enroll/sample",
    { bodyLimit: MAX_UTTERANCE_BYTES, onRequest: enrollGuard },
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "Send the recording as audio/*" });
      if (body.length === 0) return reply.code(400).send({ error: "Empty recording" });
      try {
        return await deps.voiceEnroll!.sample(body, String(req.headers["content-type"] ?? "audio/webm"));
      } catch (e) {
        return enrollError(reply, e, "sample");
      }
    },
  );
  app.post("/api/voice/enroll/finish", { onRequest: enrollGuard }, async (req, reply) => {
    const body = PinBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN to save your voice" });
    try {
      return await deps.voiceEnroll!.finish(body.data.pin, req.ip);
    } catch (e) {
      return enrollError(reply, e, "finish");
    }
  });
  app.post("/api/voice/enroll/cancel", { onRequest: enrollGuard }, async () => {
    deps.voiceEnroll!.cancel();
    return { ok: true };
  });
  app.delete("/api/voice/enroll", { onRequest: enrollGuard }, async (req, reply) => {
    const body = PinBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN to delete your voice" });
    try {
      await deps.voiceEnroll!.remove(body.data.pin, req.ip);
      return { ok: true };
    } catch (e) {
      return enrollError(reply, e, "remove");
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
