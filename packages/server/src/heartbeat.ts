import type { TaskRow, Tasks } from "./tasks";

export interface HeartbeatDeps {
  tasks: Tasks;
  /** How many owner screens are connected right now. */
  clients: () => number;
  /** A reminder fell due and no screen is open: tries to tell the owner another way (their phone). True when it did, so the task is done. */
  away?: (task: TaskRow) => Promise<boolean>;
  /** The agent is in the middle of a conversation. */
  busy: () => boolean;
  /** Tell the owner. If it throws, the task stays due and is tried again on the next beat. */
  notify: (task: TaskRow) => void;
  intervalMs?: number;
}

/**
 * The server's pulse. On every beat it looks for tasks that have fallen due and tells the owner.
 * It only ever notifies: no model turn is started and no tool runs because a reminder came due.
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;

  constructor(private deps: HeartbeatDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs ?? 15_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private sending = new Set<number>();

  tick(): void {
    const d = this.deps;
    if (d.clients() === 0) {
      // nobody at a screen: tell the owner another way if there is one; otherwise it stays due until a screen opens
      if (!d.away) return;
      for (const task of d.tasks.due()) {
        if (this.sending.has(task.id)) continue;
        this.sending.add(task.id);
        void d
          .away(task)
          .then((ok) => ok && d.tasks.markFired(task.id))
          .catch(() => {})
          .finally(() => this.sending.delete(task.id));
      }
      return;
    }
    if (d.busy()) return; // not a good moment: it stays due
    for (const task of d.tasks.due()) {
      try {
        d.notify(task);
      } catch {
        continue; // leave it due; the next beat tries again
      }
      d.tasks.markFired(task.id);
    }
  }
}
