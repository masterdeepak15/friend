import { PcUp, type PcDown, type PcPermissions, type PcStatus } from "@friend/protocol";
import { randomUUID } from "node:crypto";
import type { PcStore } from "./store";

/** The part of a WebSocket the hub uses (so tests can use a fake). */
export interface PcSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: Buffer | string) => void): unknown;
  on(event: "close" | "error", cb: () => void): unknown;
}

export type PcExecResult = { ok: true; output: string; truncated: boolean; image?: { mime: string; data: string } } | { ok: false; error: string } | { ok: false; error: string; needsApproval: { reason: string; detail: string } };
export type PcChange = "online" | "offline" | "status" | "lease";

interface Lease {
  id: string;
  /** null: no time limit. */
  until: number | null;
  paused: boolean;
}

interface Conn {
  ws: PcSocket;
  name: string;
  status: PcStatus | null;
  lease: Lease | null;
  pending: Map<string, { resolve: (r: PcExecResult) => void; timer: NodeJS.Timeout }>;
}

const DEFAULT_LEASE_MINUTES = 30;

/** The PCs that are connected right now: their sockets, status, control sessions and the calls waiting for an answer. */
export class PcHub {
  private conns = new Map<number, Conn>();
  private listeners = new Set<(pcId: number, why: PcChange) => void>();
  private readonly clock: () => number;
  private readonly store: PcStore;

  private readonly onHello: ((pcId: number, hello: { os: string; host: string; version: string; agentSha256?: string | undefined }) => void) | undefined;

  constructor(deps: { store: PcStore; clock?: () => number; onHello?: (pcId: number, hello: { os: string; host: string; version: string; agentSha256?: string | undefined }) => void }) {
    this.onHello = deps.onHello;
    this.store = deps.store;
    this.clock = deps.clock ?? Date.now;
  }

  onChange(cb: (pcId: number, why: PcChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private notify(pcId: number, why: PcChange): void {
    for (const l of this.listeners) l(pcId, why);
  }

  attach(pcId: number, ws: PcSocket): void {
    const pc = this.store.get(pcId);
    if (!pc || pc.revoked) return void ws.close(4403, "revoked");
    this.drop(pcId, 4000, "replaced");
    const conn: Conn = { ws, name: pc.name, status: null, lease: null, pending: new Map() };
    this.conns.set(pcId, conn);
    ws.on("message", (data) => this.onMessage(pcId, conn, data));
    ws.on("close", () => this.onClose(pcId, conn));
    ws.on("error", () => {});
    this.store.touch(pcId);
    this.notify(pcId, "online");
  }

  private onMessage(pcId: number, conn: Conn, data: Buffer | string): void {
    if (this.conns.get(pcId) !== conn) return; // a late message from a socket that was replaced
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return;
    }
    const msg = PcUp.safeParse(json);
    if (!msg.success) return;
    const m = msg.data;
    switch (m.type) {
      case "hello":
        this.store.setIdentity(pcId, m.os, m.host);
        this.onHello?.(pcId, m);
        return;
      case "status":
        conn.status = m.status;
        this.store.setStatus(pcId, m.status);
        this.notify(pcId, "status");
        return;
      case "human.input":
        if (conn.lease) {
          conn.lease.paused = true;
          this.notify(pcId, "lease");
        }
        return;
      case "lease.ended":
        conn.lease = null;
        this.notify(pcId, "lease");
        return;
      case "tool.result": {
        const p = conn.pending.get(m.id);
        if (!p) return;
        conn.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve({ ok: true, output: m.result.output, truncated: m.result.truncated, ...(m.result.image ? { image: m.result.image } : {}) });
        return;
      }
      case "tool.error": {
        const p = conn.pending.get(m.id);
        if (!p) return;
        conn.pending.delete(m.id);
        clearTimeout(p.timer);
        p.resolve(m.needsApproval ? { ok: false, error: m.error, needsApproval: m.needsApproval } : { ok: false, error: m.error });
        return;
      }
    }
  }

  private onClose(pcId: number, conn: Conn): void {
    for (const [id, p] of conn.pending) {
      clearTimeout(p.timer);
      conn.pending.delete(id);
      p.resolve({ ok: false, error: "The PC disconnected." });
    }
    if (this.conns.get(pcId) !== conn) return;
    this.conns.delete(pcId);
    this.notify(pcId, "offline");
  }

  private drop(pcId: number, code: number, reason: string): void {
    const c = this.conns.get(pcId);
    if (!c) return;
    this.conns.delete(pcId);
    for (const [id, p] of c.pending) {
      clearTimeout(p.timer);
      c.pending.delete(id);
      p.resolve({ ok: false, error: "The PC disconnected." });
    }
    try {
      c.ws.close(code, reason);
    } catch {
      /* already closed */
    }
    this.notify(pcId, "offline");
  }

  isOnline(pcId: number): boolean {
    return this.conns.has(pcId);
  }
  statusOf(pcId: number): PcStatus | null {
    return this.conns.get(pcId)?.status ?? null;
  }

  /** Which PC a call is for. With no name: the only one online, or a question when there are several. */
  resolve(name?: string): { pcId: number; name: string } | { ask: string } | { error: string } {
    const all = this.store.list().filter((p) => !p.revoked);
    const online = all.filter((p) => this.conns.has(p.id));
    if (!name || !name.trim()) {
      if (online.length === 1) return { pcId: online[0]!.id, name: online[0]!.name };
      if (online.length === 0) return { error: all.length ? `No PC is online. The PCs are: ${all.map((p) => p.name).join(", ")}.` : "No PC is online, and none was added yet." };
      return { ask: `Which PC? Online now: ${online.map((p) => p.name).join(", ")}.` };
    }
    const q = name.trim().toLowerCase();
    const exact = all.find((p) => p.name.toLowerCase() === q);
    const starts = all.filter((p) => p.name.toLowerCase().startsWith(q));
    const pick = exact ?? (starts.length === 1 ? starts[0] : undefined);
    if (!pick) return starts.length > 1 ? { ask: `Which PC: ${starts.map((p) => p.name).join(" or ")}?` } : { error: `There is no PC called ${name.trim()}. The PCs are: ${all.map((p) => p.name).join(", ") || "none yet"}.` };
    return this.conns.has(pick.id) ? { pcId: pick.id, name: pick.name } : { error: `${pick.name} is offline.` };
  }

  /** Sends a tool to a PC and waits for the answer. */
  exec(pcId: number, tool: string, args: unknown, timeoutMs: number, opts: { approved?: boolean; permissions?: PcPermissions } = {}): Promise<PcExecResult> {
    const conn = this.conns.get(pcId);
    if (!conn) return Promise.resolve({ ok: false, error: "The PC is not connected." });
    const id = randomUUID();
    return new Promise<PcExecResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ ok: false, error: `The PC did not answer within ${Math.round(timeoutMs / 1000)} seconds (timed out).` });
      }, timeoutMs);
      conn.pending.set(id, { resolve, timer });
      const down: PcDown = { type: "tool.exec", id, tool, args, ...(opts.approved ? { approved: true } : {}), ...(opts.permissions ? { permissions: opts.permissions } : {}) };
      conn.ws.send(JSON.stringify(down));
    });
  }

  /** Pushes new permissions to a connected PC. */
  sendPermissions(pcId: number, permissions: PcPermissions): void {
    this.send(pcId, { type: "permissions", permissions });
  }

  send(pcId: number, m: PcDown): void {
    this.conns.get(pcId)?.ws.send(JSON.stringify(m));
  }

  startLease(pcId: number, minutes?: number): { ok: true; until: number } | { ok: false; error: string } {
    const conn = this.conns.get(pcId);
    if (!conn) return { ok: false, error: "The PC is not connected." };
    if (conn.lease && !conn.lease.paused && (conn.lease.until === null || conn.lease.until > this.clock())) return { ok: false, error: "A control session is already running on this PC." };
    const m = minutes ?? DEFAULT_LEASE_MINUTES;
    const until = this.clock() + m * 60_000;
    conn.lease = { id: randomUUID(), until, paused: false };
    this.send(pcId, { type: "lease.start", id: conn.lease.id, minutes: m });
    this.notify(pcId, "lease");
    return { ok: true, until };
  }

  endLease(pcId: number, _reason = "ended"): void {
    const conn = this.conns.get(pcId);
    if (!conn?.lease) return;
    conn.lease = null;
    this.send(pcId, { type: "lease.end" });
    this.notify(pcId, "lease");
  }

  /** Whether the PC's screen and input may be used right now. */
  leaseActive(pcId: number): boolean {
    const l = this.conns.get(pcId)?.lease;
    if (!l || l.paused) return false;
    if (l.until !== null && l.until <= this.clock()) {
      this.conns.get(pcId)!.lease = null;
      return false;
    }
    return true;
  }

  leaseInfo(pcId: number): { until: number | null; paused: boolean } | null {
    const l = this.conns.get(pcId)?.lease;
    return l ? { until: l.until, paused: l.paused } : null;
  }

  /** The PC was revoked or removed: tell it, close the socket at once, and end everything it was doing. */
  revoke(pcId: number): void {
    const c = this.conns.get(pcId);
    if (!c) return;
    try {
      c.ws.send(JSON.stringify({ type: "revoke" } satisfies PcDown));
    } catch {
      /* closing anyway */
    }
    this.drop(pcId, 4403, "revoked");
  }

  /** Every PC that is connected, with its name. */
  online(): { pcId: number; name: string; status: PcStatus | null }[] {
    return [...this.conns.entries()].map(([pcId, c]) => ({ pcId, name: c.name, status: c.status }));
  }
}
