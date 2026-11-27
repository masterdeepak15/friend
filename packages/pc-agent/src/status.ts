import type { PcStatus } from "@friend/protocol";
import type { AgentStore } from "./store";

export interface StatusDeps {
  store: AgentStore;
  /** Sends the status to Friend (and the banner). */
  push(s: PcStatus): void;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  heartbeatMs?: number;
}

/**
 * The one status record the PC always keeps: what it is doing, the task, the last action. It is written to the agent's database on
 * every change, pushed at once, and pushed again every 15 seconds so Friend always has a fresh one (and notices a PC that went quiet).
 */
export class StatusKeeper {
  private cur: PcStatus;
  private cancel: (() => void) | null = null;

  constructor(private readonly deps: StatusDeps) {
    this.cur = deps.store.status() ?? { state: "idle", at: deps.now() };
    // after a restart nothing is being controlled
    if (this.cur.state === "controlling" || this.cur.state === "paused" || this.cur.state === "waiting") this.cur = { ...this.cur, state: "idle", at: deps.now() };
  }

  current(): PcStatus {
    return { ...this.cur };
  }

  /** Changes part of the status. Pushed and saved only when something actually changed. */
  set(patch: Partial<Omit<PcStatus, "at">>): void {
    const next: PcStatus = { ...this.cur, ...patch, at: this.deps.now() };
    for (const k of ["task", "last"] as const) if (patch[k] === undefined && k in patch) delete next[k];
    const changed = (["state", "task", "last", "sessions"] as const).some((k) => this.cur[k] !== next[k]);
    this.cur = next;
    if (!changed) return;
    this.deps.store.setStatus(next);
    this.deps.push({ ...next });
  }

  /** Starts the heartbeat. */
  start(): void {
    this.stop();
    const beat = (): void => {
      this.cur = { ...this.cur, at: this.deps.now() };
      this.deps.push({ ...this.cur });
      this.cancel = this.deps.setTimer(beat, this.deps.heartbeatMs ?? 15_000);
    };
    this.cancel = this.deps.setTimer(beat, this.deps.heartbeatMs ?? 15_000);
  }

  stop(): void {
    this.cancel?.();
    this.cancel = null;
  }
}
