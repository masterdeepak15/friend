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

export interface AppOptions {
  dataDir: string;
  provider?: Provider;
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
  const statusMsg = (): ServerMsg => ({ type: "status", busy: agent.isBusy(), deviceOnline: devices.hasOnline() });
  devices.onChange(() => broadcast(statusMsg()));

  const gateway = createGateway({
    config,
    auth,
    audit,
    webDir: opts.webDir,
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
        case "ping":
          conn.send(statusMsg());
          break;
        case "stage.event":
          audit.log("owner", "stage.event", { objectId: msg.objectId, event: msg.event });
          break;
      }
    },
    onDeviceConnect: (device, ws) => devices.attach(device, ws),
    onLock: () => {
      agent.cancel();
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
