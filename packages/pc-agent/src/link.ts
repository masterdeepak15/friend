import { PcDown, type PcUp } from "@friend/protocol";

/** The part of a WebSocket the link uses (so tests can use a fake). */
export interface WsLike {
  send(data: string): void;
  close(code?: number): void;
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (data: Buffer | string) => void): unknown;
  on(event: "close", cb: (code: number) => void): unknown;
  on(event: "error", cb: () => void): unknown;
}

export type LinkState = "connecting" | "online" | "offline" | "revoked";

export interface LinkDeps {
  /** A valid access token, refreshed when it is about to run out; "offline" when Friend cannot be reached; null when there is no sign-in at all. */
  getAccess(): Promise<string | null | "offline">;
  /** Trades the refresh token for a new pair: "refused" means the sign-in is over (revoked). */
  refresh(): Promise<"ok" | "refused" | "offline">;
  onMessage(m: PcDown): void;
  onState(s: LinkState): void;
  connect(token: string): WsLike;
  setTimer(fn: () => void, ms: number): () => void;
  /** 0 to 1, for a little spread in the retry time. */
  random?(): number;
}

const MIN_MS = 1000;
const MAX_MS = 60_000;

/** The outbound connection to Friend: it reconnects with a growing wait, refreshes the sign-in when Friend says it ran out, and stops for good when the PC was revoked. */
export class Link {
  private ws: WsLike | null = null;
  private attempt = 0;
  private cancelRetry: (() => void) | null = null;
  private stopped = true;
  private refreshedThisTry = false;
  private open = false;

  constructor(private readonly deps: LinkDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    try {
      ws?.close(1000);
    } catch {
      /* already closed */
    }
  }

  online(): boolean {
    return this.open;
  }

  /** Sends a message; false when the PC is not connected (nothing is queued: a stale status is worse than none). */
  send(m: PcUp): boolean {
    if (!this.open || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(m));
      return true;
    } catch {
      return false;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.deps.onState("connecting");
    const token = await this.deps.getAccess().catch(() => "offline" as const);
    if (this.stopped) return;
    if (token === "offline") {
      this.deps.onState("offline");
      return this.retry();
    }
    if (!token) return this.revoked();
    let ws: WsLike;
    try {
      ws = this.deps.connect(token);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.attempt = 0;
      this.refreshedThisTry = false;
      this.deps.onState("online");
    });
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      const m = PcDown.safeParse(json);
      if (m.success) this.deps.onMessage(m.data);
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.open = false;
      if (this.stopped) return;
      if (code === 4403) return this.revoked();
      if (code === 4401) return void this.expired();
      this.deps.onState("offline");
      this.retry();
    });
  }

  /** Friend did not accept the access token: try the refresh token once, then give up. */
  private async expired(): Promise<void> {
    if (this.refreshedThisTry) return this.revoked();
    this.refreshedThisTry = true;
    const r = await this.deps.refresh().catch(() => "offline" as const);
    if (this.stopped) return;
    if (r === "refused") return this.revoked();
    if (r === "offline") {
      this.refreshedThisTry = false;
      this.deps.onState("offline");
      return this.retry();
    }
    void this.connect();
  }

  private revoked(): void {
    this.stopped = true;
    this.deps.onState("revoked");
  }

  private retry(): void {
    if (this.stopped) return;
    const base = Math.min(MAX_MS, MIN_MS * 2 ** this.attempt++);
    const spread = 1 + ((this.deps.random?.() ?? 0.5) - 0.5) * 0.4;
    this.cancelRetry = this.deps.setTimer(() => void this.connect(), Math.round(base * spread));
  }
}
