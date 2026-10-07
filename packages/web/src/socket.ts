import type { ClientMsg } from "@friend/protocol";
import type { Connection } from "./store";

export interface FriendSocket {
  send(m: ClientMsg): void;
  onMessage(cb: (m: unknown) => void): () => void;
  onState(cb: (s: Connection) => void): () => void;
  state(): Connection;
  close(): void;
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/** Reconnecting WebSocket. A 4401 close means the session is gone: stop and report "unauthorized". */
export function createSocket(url: string = wsUrl()): FriendSocket {
  let ws: WebSocket | null = null;
  let state: Connection = "connecting";
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const msgCbs = new Set<(m: unknown) => void>();
  const stateCbs = new Set<(s: Connection) => void>();
  const setState = (s: Connection) => {
    state = s;
    stateCbs.forEach((cb) => cb(s));
  };

  function connect() {
    if (closed) return;
    setState("connecting");
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      setState("open");
    };
    sock.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data));
        msgCbs.forEach((cb) => cb(data));
      } catch {
        /* ignore malformed frames */
      }
    };
    sock.onclose = (ev) => {
      if (closed) return;
      if (ev.code === 4401) return setState("unauthorized");
      setState("closed");
      timer = setTimeout(connect, Math.min(500 * 2 ** attempt++, 8000));
    };
    sock.onerror = () => {};
  }
  connect();

  return {
    send(m) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    onMessage(cb) {
      msgCbs.add(cb);
      return () => msgCbs.delete(cb);
    },
    onState(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    state: () => state,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
