import type { ClientMsg, ServerMsg } from "@friend/protocol";
import { Agent } from "./agent/loop";
import { Approvals } from "./approvals";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig, type Config } from "./config";
import { openDb } from "./db";
import { DeviceHub } from "./devices";
import { createGateway, type ClientConn } from "./gateway";
import { PolicyEngine } from "./policy/engine";
import { ClaudeProvider } from "./provider/claude";
import type { Provider, ProviderEvent, StreamRequest } from "./provider/types";
import { StageState } from "./stage";
import { HttpError } from "./http-error";
import { VoiceError, type VoiceService } from "./voice/service";
import { Speaker } from "./voice/speaker";

export interface AppOptions {
  dataDir: string;
  provider?: Provider;
  /** Speech in and out; without it voice is simply unavailable. */
  voice?: VoiceService;
  config?: Partial<Config>;
  webDir?: string;
  expireIntervalMs?: number;
  approvalTimeoutMs?: number;
}

/** Used when no API key is configured: every turn ends with a setup notice on screen. */
class MissingKeyProvider implements Provider {
  id = "missing-key";
  async *stream(_req: StreamRequest): AsyncIterable<ProviderEvent> {
    yield {
      type: "error",
      userFacing: true,
      message: "I need an Anthropic API key before I can think. Run: friend config set apiKey <your key>",
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
    opts.provider ?? (config.apiKey ? new ClaudeProvider({ apiKey: config.apiKey, model: config.model }) : new MissingKeyProvider());
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
  });

  const clients = new Set<ClientConn>();
  const broadcast = (m: ServerMsg) => {
    for (const c of clients) c.send(m);
  };
  const voice = opts.voice;
  const speaker = voice ? new Speaker(voice, audit, config.voice.ttsVoice) : null;
  const voiceAvailable = () => !!voice && voice.available();
  const statusMsg = (): ServerMsg => ({
    type: "status",
    busy: agent.isBusy(),
    deviceOnline: devices.hasOnline(),
    voiceAvailable: voiceAvailable(),
  });
  devices.onChange(() => broadcast(statusMsg()));

  /** Bumped by the emergency lock: anything that started before it must not start or speak after it. */
  let lockEpoch = 0;

  /** Runs the turn for something the owner said, then speaks the reply. */
  async function runVoiceTurn(text: string, ip: string, epoch: number): Promise<void> {
    let reply = "";
    const emit = (m: ServerMsg) => {
      if (m.type === "caption.delta") reply += m.text;
      broadcast(m);
    };
    await agent.runTurn(text, { trust: "owner", emit, ip });
    if (epoch !== lockEpoch) return; // locked while the agent was working: stay silent
    if (speaker && reply.trim()) await speaker.speak(reply, broadcast);
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
      let heard: string;
      try {
        heard = (await voice.transcribe(audio, mime, config.voice.language)).text.trim();
      } catch (e) {
        // our own voice errors carry no internal detail and can be shown; anything else stays in the audit log
        if (e instanceof VoiceError) throw new HttpError(502, e.message);
        throw e;
      }
      // the session may have been locked or logged out while the recording was being transcribed
      if (epoch !== lockEpoch || !auth.sessionActive(session.id)) throw new HttpError(401, "Session ended");
      // nothing intelligible (silence, noise, punctuation only): no turn, nothing shown
      if (!/[\p{L}\p{N}]/u.test(heard)) return { text: "" };
      broadcast({ type: "voice.heard", text: heard });
      void runVoiceTurn(heard, ip, epoch).catch((e) => audit.log("system", "voice.turn_crash", { message: (e as Error).message }));
      return { text: heard };
    },
    onClientConnect: (_session, conn) => {
      clients.add(conn);
      conn.send({ type: "snapshot", stage: stage.snapshot(), pendingApproval: approvals.pending() });
      conn.send(statusMsg());
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
    /** Tell every client the voice sidecar went up or down. */
    notifyStatus(): void {
      broadcast(statusMsg());
    },
    async start(): Promise<{ port: number }> {
      timer = setInterval(() => {
        for (const id of stage.expire()) broadcast({ type: "stage", command: { cmd: "hide", id } });
      }, opts.expireIntervalMs ?? 1000);
      return gateway.listen();
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      agent.cancel();
      approvals.denyAll("Shutting down");
      await gateway.close();
      db.close();
    },
  };
}
