import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { ClientMsg, type ServerMsg } from "@friend/protocol";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { createReadStream, existsSync, promises as fsp } from "node:fs";
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
  /** A key and certificate: serve https:// instead of http://. */
  tls?: { key: string; cert: string };
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
  /** Teaching Friend the voices of the household; the routes answer 503 without it. */
  household?: HouseholdApi;
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
  /** A picture of the Friend screen arrived for a screen.look request. */
  onScreenFrame?: (id: string, jpeg: Buffer) => "ok" | "unknown" | "invalid";
  /** Telegram, SMS and WhatsApp: status and linking for the owner's screen, and Twilio's inbound messages. */
  channels?: ChannelsApi;
  /** Stock brokers: the login return, the owner's status and schedules. */
  brokers?: BrokersApi;
  /** Alexa: the skill's endpoint (called by Amazon) and the owner's device list. */
  alexa?: AlexaApi;
  /** The owner's music: the list, the audio and the covers. */
  music?: MusicApi;
  /** Files the owner approved to be shown (file.present); the media route answers 404 without it. */
  media?: { lookup(id: string): { path: string; mime: string; size: number } | null };
}

export const MAX_CAMERA_FRAME_BYTES = 2 * 1024 * 1024;

/** What the channel routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface ChannelsApi {
  status(): unknown;
  link(pin: string | undefined, ip: string): Promise<unknown>;
  unlink(pin: string | undefined, ip: string): Promise<unknown>;
  twilioInbound(url: string, params: Record<string, string>, signature: string | undefined): "ok" | "forbidden" | "off";
}

/** What the broker routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface BrokersApi {
  status(): unknown;
  /** The broker's redirect after the owner logged in. True when the login was accepted. */
  callback(params: Record<string, string>): Promise<boolean>;
  loginLink(send: boolean): Promise<unknown>;
  schedules(): unknown;
  addSchedule(input: unknown, pin: string, ip: string): Promise<unknown>;
  removeSchedule(id: number): boolean;
  run(kind: string | undefined, send: boolean): Promise<{ status: number; body: unknown }>;
}

/** What the Alexa routes need from the app. Errors thrown as HttpError are shown to the owner as they are. */
export interface AlexaApi {
  /** Amazon's request: the raw body and headers. The answer is the status and JSON Alexa should get. */
  handle(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: number; body: unknown }>;
  status(): unknown;
  allow(short: string, name: string, pin: string, ip: string): Promise<unknown>;
  forget(short: string): boolean;
  packageFile(name: string): { type: string; text: string } | null;
}

/** What the music routes need from the app. Nothing here is a path the browser could ask for: only ids Friend made. */
export interface MusicApi {
  library(q: { q?: string; offset?: number; limit?: number }): unknown | Promise<unknown>;
  /** The audio file behind a track id, checked just now, or null. */
  track(id: string): Promise<{ path: string; mime: string } | null>;
  cover(id: string): Promise<{ mime: string; data: Buffer } | null>;
  rescan(): Promise<{ count: number; truncated: boolean; problem?: string }>;
  /** Every music source and what the owner needs to do for it, plus what the Spotify plugin page shows. No tokens. */
  sources(): unknown;
  search(q: { q: string; source?: "local" | "spotify" | "any"; limit?: number }): Promise<unknown>;
  /** Needs the owner's PIN. Gives the address to send the owner's browser to. */
  spotifyConnect(pin: string, ip: string): Promise<{ url: string }>;
  spotifyDisconnect(pin: string, ip: string): Promise<{ ok: true }>;
  /** Needs the owner's PIN. The id of the owner's own Spotify app (not secret). */
  spotifySetClientId(clientId: string, pin: string, ip: string): Promise<{ ok: true }>;
  /** The return from Spotify. True when the login was completed. */
  spotifyCallback(params: Record<string, string>): Promise<boolean>;
}

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
  /** What a one-click connector needs and whether it is on this PC. Starts nothing and needs no PIN. */
  quickCheck(preset: string): unknown;
  /** Installs what it needs, in the background. Needs the PIN: it runs a program that changes this PC. */
  quickInstall(preset: string, pin: string, ip: string): Promise<unknown>;
  /** Adds the connector with its fixed command and connects it. Needs the PIN. */
  quickConnect(preset: string, pin: string, ip: string): Promise<unknown>;
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

/** The other people whose voices Friend knows (wife, son, daughter...). Owner only; saving or removing a voice needs the PIN. */
export interface HouseholdApi {
  overview(): {
    people: { id: number; name: string; samples: number; createdAt: number }[];
    max: number;
    ownerEnrolled: boolean;
    enrolling: { name: string; samples: number; min: number; max: number; enrolled: boolean } | null;
  };
  begin(name: string): { name: string; samples: number; min: number; max: number; enrolled: boolean };
  sample(audio: Buffer, mime: string): Promise<{ count: number; note: string | null }>;
  finish(pin: string, ip: string): Promise<{ samples: number; name: string }>;
  cancel(): void;
  remove(id: number, pin: string, ip: string): Promise<void>;
}

export const MAX_UTTERANCE_BYTES = 4 * 1024 * 1024;

/** "45 seconds", "2 minutes", "1 hour": how long a lock lasts, in words. */
function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

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
  const app: FastifyInstance = Fastify(deps.tls ? ({ ...options, https: { key: deps.tls.key, cert: deps.tls.cert } } as unknown as FastifyServerOptions) : options);
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

  // Whether this browser is signed in. The screen asks before it draws anything, so the home screen is never shown to someone who is not.
  app.get("/api/session", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    reply.header("cache-control", "no-store");
    return { signedIn: !!token && !!auth.resolveSession(token) };
  });

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
      reply.header("cache-control", "no-store");
      if (e instanceof LockoutError) {
        const seconds = Math.max(1, Math.ceil(e.retryAfterMs / 1000));
        return reply.code(429).header("retry-after", seconds).send({ error: `Too many wrong passwords. Try again in ${waitText(seconds)}.`, retryAfterSeconds: seconds });
      }
      // a wrong password: say how many tries are left, or that the address is now locked and for how long
      const state = auth.loginState(req.ip);
      const seconds = Math.ceil(state.retryAfterMs / 1000);
      if (seconds > 0) return reply.code(401).send({ error: `Wrong password. Locked for ${waitText(seconds)}.`, triesLeft: 0, retryAfterSeconds: seconds });
      return reply.code(401).send({ error: "Invalid credentials", triesLeft: state.triesLeft });
    }
  });

  app.post("/api/logout", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    if (token) auth.revokeSession(token);
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  // Change the password and/or PIN. Needs a signed-in browser and the current password; wrong guesses share the sign-in lock.
  app.post("/api/account/secret", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const token = req.cookies[COOKIE_NAME];
    if (!token || !auth.resolveSession(token)) return reply.code(401).send({ error: "Please sign in again." });
    const body = z
      .object({ current: z.string().min(1).max(1024), newPassword: z.string().max(1024).optional(), newPin: z.string().max(128).optional() })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    const { current, newPassword, newPin } = body.data;
    try {
      await auth.changeSecrets({ current, newPassword, newPin }, req.ip, token);
      return { ok: true, signedOutOthers: newPassword !== undefined };
    } catch (e) {
      if (e instanceof LockoutError) {
        const seconds = Math.max(1, Math.ceil(e.retryAfterMs / 1000));
        return reply.code(429).header("retry-after", seconds).send({ error: `Too many wrong passwords. Try again in ${waitText(seconds)}.`, retryAfterSeconds: seconds });
      }
      if ((e as Error).message === "Invalid credentials") {
        const state = auth.loginState(req.ip);
        const seconds = Math.ceil(state.retryAfterMs / 1000);
        if (seconds > 0) return reply.code(401).send({ error: `Wrong password. Locked for ${waitText(seconds)}.`, triesLeft: 0, retryAfterSeconds: seconds });
        return reply.code(401).send({ error: "The current password is wrong.", triesLeft: state.triesLeft });
      }
      return reply.code(400).send({ error: (e as Error).message });
    }
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

  // ---- pictures of the Friend screen (screen.look), uploaded like camera pictures ----
  app.post<{ Params: { id: string } }>(
    "/api/screen/frame/:id",
    {
      bodyLimit: MAX_CAMERA_FRAME_BYTES * 4,
      onRequest: async (req, reply) => {
        const token = req.cookies[COOKIE_NAME];
        const session = token ? auth.resolveSession(token) : null;
        if (!session) return reply.code(401).send({ error: "Unauthorized" });
        if (!cameraWindow.allow(`screen:${session.id}`)) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
        if (!deps.onScreenFrame) return reply.code(503).send({ error: "Looking at the screen is not available" });
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "Send the picture as image/jpeg" });
      const out = deps.onScreenFrame!(req.params.id, body);
      if (out === "unknown") return reply.code(404).send({ error: "Nobody is waiting for that picture" });
      if (out === "invalid") return reply.code(400).send({ error: "That is not a JPEG picture" });
      return { ok: true };
    },
  );

  // ---- files the owner approved to be shown (images, video, PDF): signed-in browsers only, with byte ranges so video can seek ----
  app.get<{ Params: { id: string } }>("/api/media/:id", async (req, reply) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token || !auth.resolveSession(token)) return reply.code(401).send({ error: "Unauthorized" });
    const grant = /^[0-9a-f]{32}$/.test(req.params.id) ? deps.media?.lookup(req.params.id) : null;
    if (!grant) return reply.code(404).send({ error: "Not found" });
    const stat = await fsp.stat(grant.path).catch(() => null);
    if (!stat || !stat.isFile()) return reply.code(404).send({ error: "The file is gone" });
    const size = stat.size;
    reply.header("accept-ranges", "bytes").header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=300");
    if (grant.mime === "image/svg+xml") reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (!(start <= end) || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
      start = Math.max(0, start);
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1).type(grant.mime).send(createReadStream(grant.path, { start, end }));
    }
    return reply.header("content-length", size).type(grant.mime).send(createReadStream(grant.path));
  });

  // ---- Telegram, SMS and WhatsApp ----
  const channelWindow = new SlidingWindow(20, 60_000);
  const channelGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    if (!token || !auth.resolveSession(token)) return reply.code(401).send({ error: "Unauthorized" });
    if (!channelWindow.allow(`ch:${req.ip}`)) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.channels) return reply.code(503).send({ error: "Messaging is not available" });
  };
  app.get("/api/channels", { onRequest: channelGuard }, async (_req, reply) => {
    reply.header("cache-control", "no-store");
    return deps.channels!.status();
  });
  for (const action of ["link", "unlink"] as const) {
    app.post(`/api/channels/telegram/${action}`, { onRequest: channelGuard }, async (req, reply) => {
      reply.header("cache-control", "no-store");
      const body = z.object({ pin: z.string().max(32).optional() }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "Invalid input" });
      try {
        return await deps.channels![action](body.data.pin, req.ip);
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
        if (e instanceof LockoutError) return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: "Too many wrong PINs. Wait a moment." });
        throw e;
      }
    });
  }
  // Twilio posts a form here for every message that arrives. It has no cookie: its signature, made with your auth token, is the proof.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    } catch (e) {
      done(e as Error);
    }
  });
  const twilioWindow = new SlidingWindow(60, 60_000);
  app.post("/api/channels/twilio", async (req, reply) => {
    if (!deps.channels) return reply.code(404).send();
    if (!twilioWindow.allow(`tw:${req.ip}`)) return reply.code(429).send();
    if (!config.publicUrl) return reply.code(503).send({ error: "Set the public address first" });
    const params = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, string>;
    const url = `${config.publicUrl.replace(/\/+$/, "")}/api/channels/twilio`;
    const out = deps.channels.twilioInbound(url, params, String(req.headers["x-twilio-signature"] ?? ""));
    if (out === "forbidden") return reply.code(403).send();
    if (out === "off") return reply.code(404).send();
    return reply.code(200).type("text/xml").send("<Response></Response>");
  });

  // ---- stock brokers ----
  // The broker sends the owner's browser here after login. There is no cookie to check: the one-time code Friend made is the proof.
  const brokerReturnWindow = new SlidingWindow(20, 60_000);
  const brokerPage = (ok: boolean) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friend</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#05080d;color:#bfefff;font-family:system-ui,sans-serif}p{padding:24px;border:1px solid #1d4f66;border-radius:8px;max-width:340px;text-align:center}</style></head><body><p>${ok ? "Logged in. You can close this tab." : "That did not work. Start again from Friend."}</p></body></html>`;
  app.get("/api/brokers/zerodha/callback", async (req, reply) => {
    if (!deps.brokers) return reply.code(404).send();
    if (!brokerReturnWindow.allow(`br:${req.ip}`)) return reply.code(429).header("retry-after", 30).send();
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) if (typeof v === "string" && k.length <= 40 && v.length <= 200) params[k] = v;
    const ok = await deps.brokers.callback(params).catch(() => false);
    return reply.code(200).header("cache-control", "no-store").header("referrer-policy", "no-referrer").type("text/html").send(brokerPage(ok));
  });
  const brokerWindow = new SlidingWindow(30, 60_000);
  const brokerGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!brokerWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.brokers) return reply.code(503).send({ error: "Brokers are not available" });
    reply.header("cache-control", "no-store");
  };
  const brokerError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof LockoutError) return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: "Too many wrong PINs. Wait a moment." });
    audit.log("owner", "broker.failed", { message: (e as Error).message });
    return reply.code(500).send({ error: "That did not work. Try again." });
  };
  app.get("/api/brokers", { onRequest: brokerGuard }, async () => deps.brokers!.status());
  app.post("/api/brokers/zerodha/login-link", { onRequest: brokerGuard }, async (req, reply) => {
    const body = z.object({ send: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      return await deps.brokers!.loginLink(body.data.send === true);
    } catch (e) {
      return brokerError(reply, e);
    }
  });
  app.get("/api/brokers/schedules", { onRequest: brokerGuard }, async () => ({ schedules: deps.brokers!.schedules() }));
  app.post("/api/brokers/schedules", { onRequest: brokerGuard }, async (req, reply) => {
    const body = z
      .object({
        pin: z.string().min(1).max(32),
        name: z.string().max(60),
        kind: z.enum(["morning", "close", "custom"]),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        days: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
        channel: z.enum(["telegram", "whatsapp", "sms"]),
        commentary: z.boolean().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Check the name, time (like 09:30), days and channel, and enter your PIN." });
    const { pin, ...input } = body.data;
    try {
      return await deps.brokers!.addSchedule(input, pin, req.ip);
    } catch (e) {
      return brokerError(reply, e);
    }
  });
  app.delete<{ Params: { id: string } }>("/api/brokers/schedules/:id", { onRequest: brokerGuard }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !deps.brokers!.removeSchedule(id)) return reply.code(404).send({ error: "There is no such schedule." });
    return { ok: true };
  });
  app.post("/api/brokers/run", { onRequest: brokerGuard }, async (req, reply) => {
    const body = z.object({ kind: z.enum(["morning", "close", "custom"]).optional(), send: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Invalid input" });
    try {
      const out = await deps.brokers!.run(body.data.kind, body.data.send === true);
      return reply.code(out.status).send(out.body);
    } catch (e) {
      return brokerError(reply, e);
    }
  });

  // ---- the owner's music (signed-in browsers only; byte ranges so the player can seek) ----
  const musicWindow = new SlidingWindow(240, 60_000);
  const musicGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!musicWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 5).send({ error: "Too many requests" });
    if (!deps.music) return reply.code(503).send({ error: "Music is not available" });
  };
  app.get<{ Querystring: { q?: string; offset?: string; limit?: string } }>("/api/music/library", { onRequest: musicGuard }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    return deps.music!.library({ q, offset: Number(req.query.offset) || 0, limit: Number(req.query.limit) || 100 });
  });
  app.get<{ Params: { id: string } }>("/api/music/track/:id", { onRequest: musicGuard }, async (req, reply) => {
    const file = await deps.music!.track(req.params.id);
    if (!file) return reply.code(404).send({ error: "Not found" });
    const info = await fsp.stat(file.path).catch(() => null);
    if (!info || !info.isFile()) return reply.code(404).send({ error: "The file is gone" });
    const size = info.size;
    reply.header("accept-ranges", "bytes").header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=300");
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      end = Math.min(end, size - 1);
      if (!(start <= end) || start >= size) return reply.code(416).header("content-range", `bytes */${size}`).send();
      start = Math.max(0, start);
      return reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1).type(file.mime).send(createReadStream(file.path, { start, end }));
    }
    return reply.header("content-length", size).type(file.mime).send(createReadStream(file.path));
  });
  app.get<{ Params: { id: string } }>("/api/music/cover/:id", { onRequest: musicGuard }, async (req, reply) => {
    const cover = await deps.music!.cover(req.params.id);
    if (!cover) return reply.code(404).send({ error: "No cover" });
    return reply.header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=3600").type(cover.mime).send(cover.data);
  });
  app.post("/api/music/rescan", { onRequest: musicGuard }, async () => deps.music!.rescan());
  const musicError = (reply: FastifyReply, e: unknown) => {
    if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof LockoutError) return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: "Too many wrong PINs. Wait a moment." });
    audit.log("owner", "music.failed", { message: (e as Error).message });
    return reply.code(500).send({ error: "That did not work. Try again." });
  };
  app.get("/api/music/sources", { onRequest: musicGuard }, async (_req, reply) => reply.header("cache-control", "no-store").send(deps.music!.sources()));
  app.get<{ Querystring: { q?: string; source?: string; limit?: string } }>("/api/music/search", { onRequest: musicGuard }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const source = req.query.source === "local" || req.query.source === "spotify" || req.query.source === "any" ? req.query.source : undefined;
    const limit = Number(req.query.limit);
    try {
      return await deps.music!.search({ q: typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "", ...(source ? { source } : {}), ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) });
    } catch (e) {
      return musicError(reply, e);
    }
  });
  for (const action of ["connect", "disconnect"] as const) {
    app.post(`/api/music/spotify/${action}`, { onRequest: musicGuard }, async (req, reply) => {
      reply.header("cache-control", "no-store");
      const body = z.object({ pin: z.string().min(1).max(32) }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "Enter your PIN" });
      try {
        return action === "connect" ? await deps.music!.spotifyConnect(body.data.pin, req.ip) : await deps.music!.spotifyDisconnect(body.data.pin, req.ip);
      } catch (e) {
        return musicError(reply, e);
      }
    });
  }
  app.post("/api/music/spotify/client-id", { onRequest: musicGuard }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const body = z.object({ clientId: z.string().max(200), pin: z.string().min(1).max(32) }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "Enter the client id and your PIN" });
    try {
      return await deps.music!.spotifySetClientId(body.data.clientId, body.data.pin, req.ip);
    } catch (e) {
      return musicError(reply, e);
    }
  });
  // Spotify sends the owner's browser here after they allow Friend. There is no cookie to check: the one-time state Friend made is the proof.
  const musicReturnWindow = new SlidingWindow(20, 60_000);
  app.get("/api/music/oauth/callback", async (req, reply) => {
    if (!deps.music) return reply.code(404).send();
    if (!musicReturnWindow.allow(`mo:${req.ip}`)) return reply.code(429).header("retry-after", 30).send();
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.query ?? {}) as Record<string, unknown>)) if (typeof v === "string" && k.length <= 40 && v.length <= 1000) params[k] = v;
    const ok = await deps.music.spotifyCallback(params).catch(() => false);
    return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(ok ? "/?music=connected" : "/?music=failed");
  });

  // ---- Alexa ----
  // Amazon calls this with a signed JSON body. The signature covers the exact bytes, so it is read as raw bytes (32 KB at most).
  let alexaLimit = config.alexa.requestsPerMinute;
  let alexaWindow = new SlidingWindow(alexaLimit, 60_000);
  void app.register(async (inst) => {
    inst.removeContentTypeParser("application/json");
    inst.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 32 * 1024 }, (_req, body, done) => done(null, body));
    inst.addHook("onRequest", async (req, reply) => {
      if (config.alexa.requestsPerMinute !== alexaLimit) {
        alexaLimit = config.alexa.requestsPerMinute; // the owner changed the setting: it applies now
        alexaWindow = new SlidingWindow(alexaLimit, 60_000);
      }
      if (!alexaWindow.allow(`alexa:${req.ip}`)) return reply.code(429).header("retry-after", 30).send();
    });
    inst.post("/api/alexa", async (req, reply) => {
      if (!deps.alexa) return reply.code(404).send();
      const out = await deps.alexa.handle(req.body as Buffer, req.headers).catch((e: Error) => {
        audit.log("anonymous", "alexa.failed", { message: e.message.slice(0, 200) });
        return { status: 500, body: { error: "That did not work." } };
      });
      return reply.code(out.status).header("cache-control", "no-store").send(out.body);
    });
  });
  const alexaOwnerWindow = new SlidingWindow(30, 60_000);
  const alexaGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return reply.code(401).send({ error: "Unauthorized" });
    if (!alexaOwnerWindow.allow(String(session.id))) return reply.code(429).header("retry-after", 10).send({ error: "Too many requests" });
    if (!deps.alexa) return reply.code(503).send({ error: "Alexa is not available" });
    reply.header("cache-control", "no-store");
  };
  app.get("/api/alexa", { onRequest: alexaGuard }, async () => deps.alexa!.status());
  app.post("/api/alexa/devices/allow", { onRequest: alexaGuard }, async (req, reply) => {
    const body = z.object({ id: z.string().length(8), name: z.string().max(40).optional(), pin: z.string().min(1).max(32) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Choose the Echo and enter your PIN." });
    try {
      return await deps.alexa!.allow(body.data.id, body.data.name ?? "", body.data.pin, req.ip);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      if (e instanceof LockoutError) return reply.code(429).header("retry-after", Math.ceil(e.retryAfterMs / 1000)).send({ error: "Too many wrong PINs. Wait a moment." });
      throw e;
    }
  });
  app.delete<{ Params: { id: string } }>("/api/alexa/devices/:id", { onRequest: alexaGuard }, async (req, reply) => {
    if (!deps.alexa!.forget(req.params.id)) return reply.code(404).send({ error: "There is no such Echo." });
    return { ok: true };
  });
  app.get<{ Params: { file: string } }>("/api/alexa/package/:file", { onRequest: alexaGuard }, async (req, reply) => {
    const file = deps.alexa!.packageFile(req.params.file);
    if (!file) return reply.code(404).send({ error: "There is no such file." });
    return reply.header("content-disposition", `attachment; filename="${req.params.file.replace(/[^A-Za-z0-9._-]/g, "_")}"`).type(file.type).send(file.text);
  });

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
  app.get<{ Params: { preset: string } }>("/api/connectors/quick/:preset", { onRequest: connectorGuard }, async (req, reply) => {
    try {
      return deps.connectors!.quickCheck(req.params.preset);
    } catch (e) {
      return connectorError(reply, e, "quick-check");
    }
  });
  for (const action of ["install", "connect"] as const) {
    app.post<{ Params: { preset: string } }>(`/api/connectors/quick/:preset/${action}`, { onRequest: connectorGuard }, async (req, reply) => {
      const body = z.object({ pin: z.string().min(1).max(32) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "Enter your PIN to continue" });
      try {
        return await (action === "install" ? deps.connectors!.quickInstall : deps.connectors!.quickConnect)(req.params.preset, body.data.pin, req.ip);
      } catch (e) {
        return connectorError(reply, e, `quick-${action}`);
      }
    });
  }
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

  // The household: the voices of the other people Friend should know. Same guard as the owner's own enrollment.
  const NameBody = z.object({ name: z.string().min(1).max(80) });
  const householdGuard = async (req: FastifyRequest, reply: FastifyReply) => {
    await enrollGuard(req, reply);
    if (reply.sent) return;
    if (!deps.household) return reply.code(503).send({ error: "Voice is not available" });
  };
  app.get("/api/voice/people", { onRequest: householdGuard }, async () => deps.household!.overview());
  app.post("/api/voice/people/begin", { onRequest: householdGuard }, async (req, reply) => {
    const body = NameBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter a name" });
    try {
      return deps.household!.begin(body.data.name);
    } catch (e) {
      return enrollError(reply, e, "person.begin");
    }
  });
  app.post("/api/voice/people/sample", { bodyLimit: MAX_UTTERANCE_BYTES, onRequest: householdGuard }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(415).send({ error: "Send the recording as audio/*" });
    if (body.length === 0) return reply.code(400).send({ error: "Empty recording" });
    try {
      return await deps.household!.sample(body, String(req.headers["content-type"] ?? "audio/webm"));
    } catch (e) {
      return enrollError(reply, e, "person.sample");
    }
  });
  app.post("/api/voice/people/finish", { onRequest: householdGuard }, async (req, reply) => {
    const body = PinBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN to save this voice" });
    try {
      return await deps.household!.finish(body.data.pin, req.ip);
    } catch (e) {
      return enrollError(reply, e, "person.finish");
    }
  });
  app.post("/api/voice/people/cancel", { onRequest: householdGuard }, async () => {
    deps.household!.cancel();
    return { ok: true };
  });
  app.delete("/api/voice/people/:id", { onRequest: householdGuard }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = PinBody.safeParse(req.body);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "Unknown person" });
    if (!body.success) return reply.code(400).send({ error: "Enter your PIN to remove this voice" });
    try {
      await deps.household!.remove(id, body.data.pin, req.ip);
      return { ok: true };
    } catch (e) {
      return enrollError(reply, e, "person.remove");
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

  // Friend's screen is open in one window at a time (like WhatsApp Web). A browser names its window with `tab`;
  // a second window is turned away (4409) until its owner chooses "Use here" (`takeover=1`), which closes the first (4410).
  // A window that reconnects or reloads is the same tab, so it just takes its own place back.
  let activeOwner: { ws: WebSocket; tab: string } | null = null;

  function handleClient(ws: WebSocket, req: IncomingMessage) {
    if (!originAllowed(req)) {
      audit.log("anonymous", "ws.origin_refused", { origin: req.headers.origin });
      return ws.close(4403, "origin");
    }
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    const session = token ? auth.resolveSession(token) : null;
    if (!session) return ws.close(4401, "unauthorized");

    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const tab = (params.get("tab") ?? "").slice(0, 64);
    if (tab) {
      if (activeOwner && activeOwner.ws.readyState === WebSocket.OPEN) {
        if (params.get("takeover") !== "1" && activeOwner.tab !== tab) return ws.close(4409, "in use elsewhere");
        activeOwner.ws.close(4410, "replaced");
      }
      const mine = { ws, tab };
      activeOwner = mine;
      ws.on("close", () => {
        if (activeOwner === mine) activeOwner = null;
      });
    }

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
      if (tab && activeOwner?.ws !== ws) return; // a window that was replaced no longer speaks for Friend
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
