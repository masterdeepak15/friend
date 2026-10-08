import type { TaskRow, Tasks } from "./tasks";

export interface HeartbeatDeps {
  tasks: Tasks;
  /** How many owner screens are connected right now. */
  clients: () => number;
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

  tick(): void {
    const d = this.deps;
    if (d.clients() === 0 || d.busy()) return; // nobody to tell, or not a good moment: it stays due
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
