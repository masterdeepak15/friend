export class LockoutError extends Error {
  constructor(public retryAfterMs: number) {
    super("Too many attempts. Try again later.");
  }
}

interface Entry {
  fails: number;
  lockedUntil: number;
  /** When it last changed; a count left alone for a day is forgotten. */
  updatedAt?: number;
}

/** Where the counts are kept between restarts. */
export interface LimiterStore {
  load(): { key: string; fails: number; lockedUntil: number; updatedAt: number }[];
  save(key: string, e: { fails: number; lockedUntil: number; updatedAt: number }): void;
  remove(key: string): void;
}

const FORGET_AFTER_MS = 24 * 3600 * 1000;

/** Locks a key after `maxFails` consecutive failures, doubling the lock for each further failure (cap 1h). */
export class RateLimiter {
  private entries = new Map<string, Entry>();

  constructor(private clock: () => number, private maxFails = 5, private baseLockMs = 60_000, private store?: LimiterStore) {
    if (!store) return;
    const now = clock();
    for (const r of store.load()) {
      if (now - r.updatedAt > FORGET_AFTER_MS) store.remove(r.key);
      else this.entries.set(r.key, { fails: r.fails, lockedUntil: r.lockedUntil, updatedAt: r.updatedAt });
    }
  }

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
    e.updatedAt = this.clock();
    this.entries.set(key, e);
    this.store?.save(key, { fails: e.fails, lockedUntil: e.lockedUntil, updatedAt: e.updatedAt });
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
    this.store?.remove(key);
  }
}
