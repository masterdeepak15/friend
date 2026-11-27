import type { AgentStore, TaskRow } from "./store";

/**
 * The work the assistant queued for this PC. One task runs at a time under the one control session; the others wait with their state.
 * They live in the agent's database, so they survive a restart: a task that was running comes back as paused and is never carried on
 * (no clicking) without a new control session.
 */
export class Tasks {
  constructor(
    private readonly store: AgentStore,
    private readonly onChange: (current: TaskRow | null) => void = () => {},
  ) {}

  add(title: string): TaskRow {
    const t = this.store.addTask(title);
    this.onChange(this.current());
    return t;
  }

  list(): TaskRow[] {
    return this.store.tasks();
  }

  current(): TaskRow | null {
    return this.store.tasks().find((t) => t.state === "running") ?? null;
  }

  /** Starts a queued or paused task. Only one runs at a time. */
  start(id: number): { ok: true; task: TaskRow } | { ok: false; error: string } {
    const t = this.store.task(id);
    if (!t) return { ok: false, error: `There is no task ${id}.` };
    if (t.state !== "queued" && t.state !== "paused") return { ok: false, error: `Task ${id} is ${t.state}.` };
    const running = this.current();
    if (running && running.id !== id) return { ok: false, error: `Task ${running.id} ("${running.title}") is running. Finish it first with done, or cancel it.` };
    this.store.setTask(id, "running");
    this.onChange(this.current());
    return { ok: true, task: this.store.task(id)! };
  }

  finish(id: number, state: "done" | "failed" | "cancelled", note?: string): { ok: true } | { ok: false; error: string } {
    const t = this.store.task(id);
    if (!t) return { ok: false, error: `There is no task ${id}.` };
    if (t.state === "done" || t.state === "failed" || t.state === "cancelled") return { ok: false, error: `Task ${id} is already ${t.state}.` };
    this.store.setTask(id, state, note);
    this.onChange(this.current());
    return { ok: true };
  }

  /** After a restart: whatever was running is paused. */
  resumeAfterRestart(): void {
    for (const t of this.store.tasks()) if (t.state === "running") this.store.setTask(t.id, "paused", "paused by a restart");
    this.onChange(null);
  }

  /** What the assistant sees. */
  describe(): string {
    const all = this.store.tasks().filter((t) => t.state !== "done" && t.state !== "cancelled" && t.state !== "failed");
    if (all.length === 0) return "No tasks waiting.";
    return all.map((t) => `${t.id}. [${t.state}] ${t.title}${t.note ? ` (${t.note})` : ""}`).join("\n");
  }
}
