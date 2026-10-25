import { WebSocket } from "ws";

type Handler = (method: string, params: Record<string, any>, sessionId?: string) => void;

/** The smallest Chrome DevTools Protocol client Friend needs: commands with answers, and the events Chrome sends. */
export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private handlers: Handler[] = [];
  private closed = false;

  private constructor(private ws: WebSocket) {
    ws.on("message", (raw) => {
      let m: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, any>; sessionId?: string };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.fail(new Error(m.error.message ?? "Chrome refused the command."));
        else p.ok(m.result ?? {});
      } else if (m.method) {
        for (const h of this.handlers) h(m.method, m.params ?? {}, m.sessionId);
      }
    });
    const end = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.fail(new Error("The browser closed."));
      this.pending.clear();
    };
    ws.on("close", end);
    ws.on("error", end);
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
      ws.once("open", () => resolve(new Cdp(ws)));
      ws.once("error", (e) => reject(e));
    });
  }

  on(h: Handler): void {
    this.handlers.push(h);
  }

  send<T = Record<string, any>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The browser closed."));
    const id = this.nextId++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), (err) => {
        if (err) {
          this.pending.delete(id);
          fail(err);
        }
      });
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
