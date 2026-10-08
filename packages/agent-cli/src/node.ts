import { DeviceDown } from "@friend/protocol";
import { WebSocket } from "ws";
import { DEFAULT_CTX, runTool } from "./tools";

export type NodeState = "connecting" | "online" | "offline" | "unauthorized" | "stopped";

export interface NodeOptions {
  url: string;
  token: string;
  roots: string[];
  reconnect?: boolean;
  /** Friend's own self-made certificate (PEM), trusted as the only authority for this connection to Friend on the same PC. */
  ca?: string;
  backoffMs?: number;
  onState?: (s: NodeState) => void;
}

export interface DeviceNode {
  stop(): void;
  /** Resolves when the gateway accepts this device; rejects if the token is refused. */
  connected: Promise<void>;
  state(): NodeState;
}

export function startDeviceNode(opts: NodeOptions): DeviceNode {
  const base = opts.backoffMs ?? 500;
  let state: NodeState = "connecting";
  let ws: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;
  let resolveConnected!: () => void;
  let rejectConnected!: (e: Error) => void;
  let settled = false;
  const connected = new Promise<void>((res, rej) => {
    resolveConnected = res;
    rejectConnected = rej;
  });
  connected.catch(() => {});

  const setState = (s: NodeState) => {
    state = s;
    opts.onState?.(s);
  };

  function connect() {
    if (stopped) return;
    setState("connecting");
    const sock = new WebSocket(opts.url, { headers: { authorization: `Bearer ${opts.token}` }, ...(opts.ca ? { ca: opts.ca } : {}) });
    ws = sock;
    sock.on("error", () => {});
    sock.on("message", async (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      if ((json as { type?: string }).type === "hello") {
        attempt = 0;
        setState("online");
        if (!settled) {
          settled = true;
          resolveConnected();
        }
        return;
      }
      const msg = DeviceDown.safeParse(json);
      if (!msg.success) return;
      const { id, tool, args, approvedOutside } = msg.data;
      const result = await runTool(tool, args, { ...DEFAULT_CTX, roots: opts.roots, allowOutside: !!approvedOutside });
      if (sock.readyState !== WebSocket.OPEN) return;
      if (result.ok) {
        sock.send(JSON.stringify({ type: "tool.result", id, result: { output: result.output, truncated: result.truncated } }));
      } else {
        sock.send(JSON.stringify({ type: "tool.error", id, error: result.error }));
      }
    });
    sock.on("close", (code) => {
      if (stopped) return;
      if (code === 4401) {
        setState("unauthorized");
        if (!settled) {
          settled = true;
          rejectConnected(new Error("unauthorized: the gateway refused this device token"));
        }
        return;
      }
      setState("offline");
      if (opts.reconnect === false) return;
      const delay = Math.min(base * 2 ** attempt, 10_000);
      attempt += 1;
      timer = setTimeout(connect, delay);
    });
  }

  connect();

  return {
    connected,
    state: () => state,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      state = "stopped";
      if (!settled) {
        settled = true;
        rejectConnected(new Error("stopped"));
      }
    },
  };
}
