export class LockoutError extends Error {
  constructor(public retryAfterMs: number) {
    super("Too many attempts. Try again later.");
  }
}

interface Entry {
  fails: number;
  lockedUntil: number;
}

/** Locks a key after `maxFails` consecutive failures, doubling the lock for each further failure (cap 1h). */
export class RateLimiter {
  private entries = new Map<string, Entry>();

  constructor(private clock: () => number, private maxFails = 5, private baseLockMs = 60_000) {}

  check(key: string): void {
    const e = this.entries.get(key);
    const now = this.clock();
    if (e && e.lockedUntil > now) throw new LockoutError(e.lockedUntil - now);
  }

  fail(key: string): void {
    const e = this.entries.get(key) ?? { fails: 0, lockedUntil: 0 };
    e.fails += 1;
    if (e.fails >= this.maxFails) {
      const over = e.fails - this.maxFails;
      e.lockedUntil = this.clock() + Math.min(this.baseLockMs * 2 ** over, 3_600_000);
    }
    this.entries.set(key, e);
  }

  /** Wrong tries left before the next lock. Once locked before, one wrong try is enough to lock again, for longer. */
  triesLeft(key: string): number {
    const e = this.entries.get(key);
    if (!e || e.fails === 0) return this.maxFails;
    return e.fails < this.maxFails ? this.maxFails - e.fails : 1;
  }

  /** How long the key is locked from now, in milliseconds (0 when it is not). */
  lockedFor(key: string): number {
    const e = this.entries.get(key);
    return e ? Math.max(0, e.lockedUntil - this.clock()) : 0;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}
