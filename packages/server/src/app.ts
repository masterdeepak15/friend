import type { ClientMsg, ServerMsg } from "@friend/protocol";
import { Agent } from "./agent/loop";
import { Approvals } from "./approvals";
import { Audit } from "./audit";
import { Auth, LockoutError } from "./auth";
import { CameraBroker } from "./camera";
import { Heartbeat } from "./heartbeat";
import { Memory } from "./memory";
import { Tasks } from "./tasks";
import { join } from "node:path";
import { loadConfig, type Config } from "./config";
import { openDb } from "./db";
import { DeviceHub } from "./devices";
import { createGateway, type ClientConn } from "./gateway";
import { PolicyEngine } from "./policy/engine";
import { ClaudeProvider } from "./provider/claude";
import { OllamaProvider } from "./provider/ollama";
import type { Provider, ProviderEvent, StreamRequest } from "./provider/types";
import { StageState } from "./stage";
import { HttpError } from "./http-error";
import { Challenges } from "./voice/challenge";
import { loadOrCreateKey } from "./voice/crypto";
import { EnrollError, Enrollment } from "./voice/enrollment";
import { VoiceError, type VoiceService } from "./voice/service";
import { Speaker } from "./voice/speaker";
import { Voiceprint, decideTrust, type VoiceTrust } from "./voice/voiceprint";

/** Recorded with each voiceprint so a model change can be told apart later. */
const SPEAKER_MODEL = "wespeaker_en_voxceleb_resnet34";

export interface AppOptions {
  dataDir: string;
  provider?: Provider;
  /** Speech in and out; without it voice is simply unavailable. */
  voice?: VoiceService;
  config?: Partial<Config>;
  webDir?: string;
  expireIntervalMs?: number;
  approvalTimeoutMs?: number;
  /** How long a camera request waits for the browser's picture. */
  cameraTimeoutMs?: number;
  /** How often the heartbeat looks for reminders that have come due. */
  heartbeatMs?: number;
}

/** Used when no API key is configured: every turn ends with a setup notice on screen. */
class MissingKeyProvider implements Provider {
  id = "missing-key";
  async *stream(_req: StreamRequest): AsyncIterable<ProviderEvent> {
    yield {
      type: "error",
      userFacing: true,
      message:
        "I need an Anthropic API key before I can think. Run: friend config set apiKey <your key>. Or use a local model: friend ollama setup --use",
    };
  }
}

export async function createApp(opts: AppOptions) {
  const config = { ...loadConfig(opts.dataDir), ...opts.config };
  const db = openDb(opts.dataDir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  const policy = new PolicyEngine(db, config);
  const devices = new DeviceHub();
  const stage = new StageState();
  const approvals = new Approvals({ auth, policy, audit, db }, opts.approvalTimeoutMs);
  const provider =
    opts.provider ??
    (config.provider === "ollama"
      ? new OllamaProvider(config.ollama)
      : config.apiKey
        ? new ClaudeProvider({ apiKey: config.apiKey, model: config.model })
        : new MissingKeyProvider());
  const camera = new CameraBroker(opts.cameraTimeoutMs);
  const memory = new Memory(db);
  const tasks = new Tasks(db);
  const agent = new Agent({
    provider,
    policy,
    approvals,
    devices,
    stage,
    db,
    audit,
    config,
    assistantName: () => auth.assistantName(),
    memory,
    tasks,
    camera: {
      request: (emit, signal) => {
        audit.log("agent", "camera.requested", {});
        return camera.request(emit, signal);
      },
    },
  });

  const clients = new Set<ClientConn>();
  const broadcast = (m: ServerMsg) => {
    for (const c of clients) c.send(m);
  };
  const voice = opts.voice;
  const speaker = voice ? new Speaker(voice, audit, config.voice.ttsVoice) : null;
  const voiceAvailable = () => !!voice && voice.available();
  // The owner's voiceprint: encrypted at rest, key in a private file next to the database.
  const voiceprint = voice ? new Voiceprint(db, loadOrCreateKey(join(opts.dataDir, "voice.key"))) : null;
  const enrollment = voiceprint ? new Enrollment(voiceprint, SPEAKER_MODEL) : null;
  const challenges = new Challenges((id) => {
    broadcast({ type: "voice.challenge.end", id });
    broadcast({ type: "alert", level: "info", text: "The voice request timed out and was dropped." });
  });
  let stopped = false;
  const statusMsg = (): ServerMsg => ({
    type: "status",
    busy: agent.isBusy(),
    deviceOnline: devices.hasOnline(),
    voiceAvailable: voiceAvailable(),
    // sockets can still close while the app shuts down, after the database is gone
    voiceEnrolled: !stopped && (voiceprint?.exists() ?? false),
  });
  devices.onChange(() => broadcast(statusMsg()));

  /** Bumped by the emergency lock: anything that started before it must not start or speak after it. */
  let lockEpoch = 0;

  // The heartbeat only notifies: an alert, a card on the screen and a spoken line. It never starts a turn or runs a tool.
  const heartbeat = new Heartbeat({
    tasks,
    clients: () => clients.size,
    busy: () => agent.isBusy(),
    intervalMs: opts.heartbeatMs,
    notify: (task) => {
      const object = {
        id: `reminder-${task.id}`,
        type: "card" as const,
        props: { title: "Reminder", text: task.title },
        placement: "center" as const,
        ttl: 90,
        style: "alert" as const,
      };
      const show = { cmd: "show" as const, object };
      stage.apply(show);
      broadcast({ type: "stage", command: show });
      broadcast({ type: "alert", level: "info", text: `Reminder: ${task.title}` });
      audit.log("system", "task.fired", { id: task.id });
      if (speaker) void speaker.speak(`Reminder: ${task.title}`, broadcast).catch(() => {});
    },
  });

  /** Checks the owner's PIN through the shared rate limit. */
  async function requirePin(pin: string, ip: string): Promise<void> {
    let ok = false;
    try {
      ok = await auth.verifyPin(pin, ip);
    } catch (e) {
      if (e instanceof LockoutError) throw new HttpError(429, e.message);
      throw e;
    }
    if (!ok) throw new HttpError(403, "Incorrect PIN");
  }

  /** How much to trust a voice. A recording too short to identify cannot be trusted, but only the PIN can settle it. */
  function judge(embedding: number[] | null): VoiceTrust {
    if (!embedding) return "challenge";
    let score: number | null;
    try {
      score = voiceprint!.score(embedding);
    } catch (e) {
      audit.log("system", "voice.score_failed", { message: (e as Error).message });
      return "guest";
    }
    if (score === null) return "guest";
    const trust = decideTrust(score, config.voice);
    audit.log("system", "voice.trust", { trust, score: Math.round(score * 1000) / 1000 });
    return trust;
  }

  /** Runs the turn for something that was said, then speaks the reply. Guests get the isolated guest turn. */
  async function runVoiceTurn(text: string, ip: string, epoch: number, trust: "owner" | "guest" = "owner"): Promise<void> {
    let reply = "";
    const emit = (m: ServerMsg) => {
      if (m.type === "caption.delta") reply += m.text;
      broadcast(m);
    };
    await agent.runTurn(text, { trust, emit, ip });
    if (epoch !== lockEpoch) return; // locked while the agent was working: stay silent
    if (speaker && reply.trim()) await speaker.speak(reply, broadcast);
  }

  /** The owner answers "was that you?" with the PIN; only then do the held-back words run, as the owner. */
  async function confirmChallenge(id: string, pin: string, conn: ClientConn): Promise<void> {
    if (!challenges.get(id)) {
      conn.send({ type: "alert", level: "info", text: "That voice request already expired." });
      return;
    }
    if (agent.isBusy()) {
      conn.send({ type: "alert", level: "warn", text: "Friend is busy with the last request. Confirm again in a moment." });
      return;
    }
    const epoch = lockEpoch;
    try {
      await requirePin(pin, conn.ip);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.status === 403 && challenges.wrongPin(id)) {
        audit.log("owner", "voice.challenge_failed", { ip: conn.ip });
        broadcast({ type: "voice.challenge.end", id });
        conn.send({ type: "alert", level: "error", text: "Too many wrong PINs. The voice request was dropped." });
      } else {
        conn.send({ type: "alert", level: e.status === 429 ? "error" : "warn", text: e.status === 403 ? "Incorrect PIN" : e.message });
      }
      return;
    }
    if (epoch !== lockEpoch) return; // locked while the PIN was being checked
    const held = challenges.take(id);
    if (!held) return; // answered, cancelled or expired meanwhile
    audit.log("owner", "voice.challenge_confirmed", { ip: conn.ip });
    broadcast({ type: "voice.challenge.end", id });
    broadcast({ type: "voice.heard", text: held.text, trust: "owner" });
    await runVoiceTurn(held.text, conn.ip, epoch);
  }

  const gateway = createGateway({
    config,
    auth,
    audit,
    webDir: opts.webDir,
    voiceAvailable,
    onVoiceUtterance: async (session, audio, mime, ip) => {
      if (!voice) throw new HttpError(503, "Voice is not available");
      if (agent.isBusy()) throw new HttpError(409, "Friend is busy with the last request. Try again in a moment.");
      const epoch = lockEpoch;
      const enrolled = voiceprint?.exists() ?? false;
      let heard: string;
      let embedding: number[] | null = null;
      try {
        const t = await voice.transcribe(audio, mime, config.voice.language, { embed: enrolled });
        heard = t.text.trim();
        embedding = t.embedding ?? null;
      } catch (e) {
        // our own voice errors carry no internal detail and can be shown; anything else stays in the audit log
        if (e instanceof VoiceError) throw new HttpError(502, e.message);
        throw e;
      }
      // the session may have been locked or logged out while the recording was being transcribed
      if (epoch !== lockEpoch || !auth.sessionActive(session.id)) throw new HttpError(401, "Session ended");
      // nothing intelligible (silence, noise, punctuation only): no turn, nothing shown
      if (!/[\p{L}\p{N}]/u.test(heard)) return { text: "" };
      const crash = (e: unknown) => audit.log("system", "voice.turn_crash", { message: (e as Error).message });
      const trust = enrolled ? judge(embedding) : "unverified";
      if (trust === "challenge") {
        // close, but not sure enough: nothing runs unless the owner confirms with the PIN
        const { challenge, replaced } = challenges.open(heard, ip);
        if (replaced) broadcast({ type: "voice.challenge.end", id: replaced });
        broadcast({ type: "voice.challenge", id: challenge.id, text: heard });
      } else if (trust === "guest") {
        broadcast({ type: "voice.heard", text: heard, trust: "guest" });
        broadcast({ type: "alert", level: "warn", text: `An unrecognized voice said: "${heard.slice(0, 200)}"` });
        audit.log("system", "voice.guest", { text: heard.slice(0, 200) });
        void runVoiceTurn(heard, ip, epoch, "guest").catch(crash);
      } else {
        broadcast({ type: "voice.heard", text: heard, trust: trust === "owner" ? "owner" : "unverified" });
        void runVoiceTurn(heard, ip, epoch).catch(crash);
      }
      return { text: heard };
    },
    voiceEnroll: enrollment && voice
      ? {
          state: () => enrollment.state(),
          sample: async (audio, mime) => {
            let embedding: number[];
            try {
              embedding = (await voice.embed(audio, mime)).embedding;
            } catch (e) {
              if (e instanceof VoiceError) throw new HttpError(400, e.message);
              throw e;
            }
            try {
              return enrollment.add(embedding);
            } catch (e) {
              if (e instanceof EnrollError) throw new HttpError(400, e.message);
              throw e;
            }
          },
          finish: async (pin, ip) => {
            await requirePin(pin, ip);
            try {
              const out = enrollment.finish();
              audit.log("owner", "voice.enrolled", { samples: out.samples, ip });
              broadcast(statusMsg());
              return out;
            } catch (e) {
              if (e instanceof EnrollError) throw new HttpError(400, e.message);
              throw e;
            }
          },
          cancel: () => enrollment.cancel(),
          remove: async (pin, ip) => {
            await requirePin(pin, ip);
            enrollment.remove();
            audit.log("owner", "voice.removed", { ip });
            broadcast(statusMsg());
          },
        }
      : undefined,
    onCameraFrame: (id, jpeg) => {
      const out = camera.deliver(id, jpeg);
      if (out === "ok") {
        audit.log("owner", "camera.frame", { bytes: jpeg.length }); // size only, never pixels
        broadcast({ type: "camera.cancel", id }); // every other tab stops waiting
      } else {
        audit.log("owner", "camera.frame_ignored", { reason: out, bytes: jpeg.length });
      }
      return out;
    },
    onClientConnect: (_session, conn) => {
      clients.add(conn);
      conn.send({ type: "snapshot", stage: stage.snapshot(), pendingApproval: approvals.pending() });
      conn.send(statusMsg());
      const pending = challenges.current();
      if (pending) conn.send({ type: "voice.challenge", id: pending.id, text: pending.text });
      return () => clients.delete(conn);
    },
    onClientMessage: (_session, msg: ClientMsg, conn) => {
      switch (msg.type) {
        case "chat.send":
          void agent
            .runTurn(msg.text, { trust: "owner", emit: broadcast, ip: conn.ip })
            .catch((e) => audit.log("system", "turn.crash", { message: (e as Error).message }));
          break;
        case "approval.respond":
          void approvals
            .respond(msg, conn.ip)
            .catch((e) => audit.log("system", "approval.error", { message: (e as Error).message }));
          break;
        case "voice.interrupt":
          speaker?.interrupt(broadcast);
          break;
        case "voice.confirm":
          void confirmChallenge(msg.id, msg.pin, conn).catch((e) => audit.log("system", "voice.confirm_error", { message: (e as Error).message }));
          break;
        case "camera.denied":
          if (camera.deny(msg.id, msg.reason)) {
            audit.log("owner", "camera.denied", { reason: msg.reason });
            broadcast({ type: "camera.cancel", id: msg.id });
          }
          break;
        case "voice.cancel":
          if (challenges.take(msg.id)) {
            audit.log("owner", "voice.challenge_cancelled", { ip: conn.ip });
            broadcast({ type: "voice.challenge.end", id: msg.id });
          }
          break;
        case "ping":
          conn.send(statusMsg());
          break;
        case "stage.event":
          audit.log("owner", "stage.event", { objectId: msg.objectId, event: msg.event });
          if (msg.event === "dismiss" && stage.apply({ cmd: "hide", id: msg.objectId }).ok) {
            broadcast({ type: "stage", command: { cmd: "hide", id: msg.objectId } });
          }
          break;
      }
    },
    onDeviceConnect: (device, ws) => devices.attach(device, ws),
    onLock: () => {
      lockEpoch++;
      const dropped = challenges.clear();
      if (dropped) broadcast({ type: "voice.challenge.end", id: dropped });
      enrollment?.cancel();
      camera.cancelAll(broadcast);
      agent.cancel();
      speaker?.interrupt(broadcast);
      approvals.denyAll("Emergency lock");
      for (const c of [...clients]) c.close(4401, "locked");
    },
  });

  let timer: NodeJS.Timeout | null = null;

  return {
    config,
    db,
    audit,
    auth,
    policy,
    approvals,
    devices,
    stage,
    agent,
    gateway,
    voiceprint,
    challenges,
    camera,
    memory,
    tasks,
    /** Tell every client the voice sidecar went up or down. */
    notifyStatus(): void {
      broadcast(statusMsg());
    },
    async start(): Promise<{ port: number }> {
      heartbeat.start();
      timer = setInterval(() => {
        for (const id of stage.expire()) broadcast({ type: "stage", command: { cmd: "hide", id } });
      }, opts.expireIntervalMs ?? 1000);
      return gateway.listen();
    },
    async stop(): Promise<void> {
      stopped = true;
      heartbeat.stop();
      if (timer) clearInterval(timer);
      challenges.clear();
      camera.cancelAll(broadcast);
      agent.cancel();
      approvals.denyAll("Shutting down");
      await gateway.close();
      db.close();
    },
  };
}
