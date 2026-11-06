export interface TurnQueueDeps {
  /** Whether the assistant is answering something right now. */
  busy(): boolean;
  /** Runs the callback as soon as she is not (several callbacks may fire at the same moment). */
  whenIdle(job: () => void): void;
}

interface Item {
  job: () => Promise<unknown>;
  done: (v: unknown) => void;
  fail: (e: unknown) => void;
}

/**
 * Things the assistant must do on her own (look at a worker's finished ticket, answer a worker's request) wait here until she is free,
 * and run one at a time. A turn started while she is busy is dropped by the agent ("still busy"), so without this a second note that
 * arrived during her work could simply be lost. Urgent items go first; nothing is ever dropped.
 */
export class TurnQueue {
  private items: Item[] = [];
  private draining = false;

  constructor(private d: TurnQueueDeps) {}

  /** Waits for her to be free, runs `job` (it should start her turn and resolve when it ends), and resolves with its result. */
  run<T>(job: () => Promise<T>, urgent = false): Promise<T> {
    return new Promise<T>((done, fail) => {
      const item: Item = { job, done: done as (v: unknown) => void, fail };
      if (urgent) this.items.unshift(item);
      else this.items.push(item);
      void this.drain();
    });
  }

  /** How many are waiting. */
  get waiting(): number {
    return this.items.length;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (!this.items.length) return;
        if (this.d.busy()) {
          await new Promise<void>((r) => this.d.whenIdle(r));
          continue;
        }
        // the check above and the start of the job are one synchronous step: nothing can make her busy in between
        const item = this.items.shift()!;
        try {
          item.done(await item.job());
        } catch (e) {
          item.fail(e);
        }
      }
    } finally {
      this.draining = false;
      if (this.items.length) void this.drain();
    }
  }
}
