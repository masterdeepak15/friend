import type { ClientMsg } from "@friend/protocol";
import type { Connection } from "./store";

export interface FriendSocket {
  send(m: ClientMsg): void;
  onMessage(cb: (m: unknown) => void): () => void;
  onState(cb: (s: Connection) => void): () => void;
  state(): Connection;
  /** "Use here": take Friend over from the other window that has it open. */
  takeOver(): void;
  close(): void;
}

/** Names this browser tab, so a reload or a reconnect is told apart from a second window. */
function tabId(): string {
  const make = () => Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem("friend.tab");
    if (!id) {
      id = make();
      sessionStorage.setItem("friend.tab", id);
    }
    return id;
  } catch {
    return make();
  }
}

export function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

/**
 * Reconnecting WebSocket. A 4401 close means the session is gone: stop and report "unauthorized".
 * A 4409 or 4410 close means Friend is open in another window: stop and report "elsewhere" until takeOver().
 */
export function createSocket(url: string = wsUrl()): FriendSocket {
  let ws: WebSocket | null = null;
  let state: Connection = "connecting";
  let closed = false;
  let attempt = 0;
  let takeover = false;
  const tab = tabId();
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
    const sock = new WebSocket(`${url}${url.includes("?") ? "&" : "?"}tab=${tab}${takeover ? "&takeover=1" : ""}`);
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      takeover = false;
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
      if (ev.code === 4409 || ev.code === 4410) return setState("elsewhere");
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
    takeOver() {
      if (closed || state !== "elsewhere") return;
      takeover = true;
      attempt = 0;
      connect();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}
