import { randomUUID } from "node:crypto";

export interface PendingChallenge {
  id: string;
  /** What the unrecognized-but-close voice said. It only runs if the owner confirms with the PIN. */
  text: string;
  ip: string;
  attempts: number;
}

/** At most one pending "was that you?" question. A newer one replaces the older; time and wrong PINs discard it. */
export class Challenges {
  private cur: PendingChallenge | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private onExpire: (id: string) => void,
    private ttlMs = 60_000,
    private maxAttempts = 3,
  ) {}

  open(text: string, ip: string): { challenge: PendingChallenge; replaced: string | null } {
    const replaced = this.clear();
    const challenge: PendingChallenge = { id: randomUUID(), text, ip, attempts: 0 };
    this.cur = challenge;
    this.timer = setTimeout(() => {
      if (this.cur?.id !== challenge.id) return;
      this.cur = null;
      this.timer = null;
      this.onExpire(challenge.id);
    }, this.ttlMs);
    this.timer.unref?.();
    return { challenge, replaced };
  }

  /** The pending challenge, if any (a client that reconnects should see it again). */
  current(): PendingChallenge | null {
    return this.cur;
  }

  get(id: string): PendingChallenge | null {
    return this.cur && this.cur.id === id ? this.cur : null;
  }

  /** Removes and returns the challenge so it can run exactly once. */
  take(id: string): PendingChallenge | null {
    const c = this.get(id);
    if (!c) return null;
    this.clear();
    return c;
  }

  /** Counts a wrong PIN; true when that was the last allowed try and the challenge is gone. */
  wrongPin(id: string): boolean {
    const c = this.get(id);
    if (!c) return false;
    c.attempts += 1;
    if (c.attempts < this.maxAttempts) return false;
    this.clear();
    return true;
  }

  /** Drops whatever is pending; returns its id. */
  clear(): string | null {
    const id = this.cur?.id ?? null;
    this.cur = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return id;
  }
}
