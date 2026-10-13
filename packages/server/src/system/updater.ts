/** True when `a` is a newer version than `b`. A build from the source code ("development") is never out of date. */
export function isNewerVersion(a: string, b: string): boolean {
  if (!/^\d/.test(a) || !/^\d/.test(b)) return false;
  const n = (v: string) => v.split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

export interface UpdateState {
  current: string;
  /** The newest version npm knows, or null before the first look. */
  latest: string | null;
  checkedAt: number | null;
  /** A newer version than this one exists. */
  available: boolean;
  /** The update has been started: Friend restarts in a moment. */
  applying: boolean;
  /** This Friend runs in the background, so it can restart itself. */
  canApply: boolean;
  /** One plain sentence about what went wrong the last time, or null. */
  error: string | null;
}

/** What the update check needs from the outside world; tests replace it. */
export interface UpdaterDeps {
  current(): string;
  /** The newest version on npm, or null when npm could not be asked. */
  latest(): Promise<string | null>;
  /** The owner's switch for updating by itself. */
  auto(): boolean;
  /** Friend is answering a request right now: it must not be restarted. */
  busy(): boolean;
  /** Only a Friend running in the background can replace itself; one in a terminal cannot. */
  canApply(): boolean;
  /** Starts the program that stops Friend, installs the version, and starts Friend again. */
  apply(version: string): Promise<boolean> | boolean;
  /** Tells the owner, on their screen. */
  notify(text: string): void;
}

export interface UpdaterTimes {
  /** How long after Friend starts before it looks. */
  firstMs?: number;
  /** How often it looks after that. */
  everyMs?: number;
  /** How long it waits before trying again when Friend was busy. */
  retryMs?: number;
}

/**
 * Looks for a newer Friend shortly after it starts and every few hours, tells the owner when there is one, and, when the owner
 * has switched automatic updates on, installs it while Friend is not busy. Switching that off leaves the owner in charge.
 */
export class Updater {
  private latest: string | null = null;
  private checkedAt: number | null = null;
  private applying = false;
  private error: string | null = null;
  private notified: string | null = null;
  private inflight: Promise<UpdateState> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private every: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly firstMs: number;
  private readonly everyMs: number;
  private readonly retryMs: number;

  constructor(
    private d: UpdaterDeps,
    t: UpdaterTimes = {},
  ) {
    this.firstMs = t.firstMs ?? 20_000;
    this.everyMs = t.everyMs ?? 6 * 3600_000;
    this.retryMs = t.retryMs ?? 5 * 60_000;
  }

  state(): UpdateState {
    const current = this.d.current();
    return { current, latest: this.latest, checkedAt: this.checkedAt, available: this.latest !== null && isNewerVersion(this.latest, current), applying: this.applying, canApply: this.d.canApply(), error: this.error };
  }

  start(): void {
    this.stop();
    this.first = setTimeout(() => {
      this.first = null;
      void this.check();
      this.every = setInterval(() => void this.check(), this.everyMs);
      this.every.unref?.();
    }, this.firstMs);
    this.first.unref?.();
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    if (this.retry) clearTimeout(this.retry);
    this.first = this.every = this.retry = null;
  }

  /** Asks npm for the newest version (one question at a time), tells the owner, and updates when that is switched on. */
  check(): Promise<UpdateState> {
    this.inflight ??= (async () => {
      try {
        const latest = await this.d.latest();
        this.checkedAt = Date.now();
        if (latest) {
          this.latest = latest;
          this.error = null;
          await this.consider();
        } else {
          this.error = "Could not ask npm for the newest version. Check the internet connection.";
        }
      } catch {
        this.error = "Could not ask npm for the newest version. Check the internet connection.";
      } finally {
        this.inflight = null;
      }
      return this.state();
    })();
    return this.inflight;
  }

  /** The owner pressed Update now: installs even when automatic updates are off, but never in the middle of an answer. */
  async applyNow(): Promise<{ ok: boolean; message: string }> {
    if (this.applying) return { ok: true, message: "The update is already running. Reload this page in a minute." };
    if (!this.latest) await this.check();
    const s = this.state();
    if (!s.latest) return { ok: false, message: s.error ?? "Could not ask npm for the newest version." };
    if (this.applying) return { ok: true, message: "The update is already running. Reload this page in a minute." };
    if (!s.available) return { ok: false, message: `Friend is up to date (${s.current}).` };
    if (!s.canApply) return { ok: false, message: "This Friend is running in a terminal and cannot restart itself. Close it and run: friend upgrade" };
    if (this.d.busy()) return { ok: false, message: "Friend is busy with a request. Try again in a moment." };
    return (await this.begin(s.latest)) ? { ok: true, message: `Updating to ${s.latest}. Friend restarts in a moment: reload this page afterwards.` } : { ok: false, message: this.error ?? "Could not start the update." };
  }

  private async consider(): Promise<void> {
    const s = this.state();
    if (!s.available || !s.latest) return;
    const canApply = this.d.canApply();
    if (this.notified !== s.latest) {
      this.notified = s.latest;
      this.d.notify(
        canApply
          ? this.d.auto()
            ? `Friend ${s.latest} is available. It will update by itself when Friend is not busy.`
            : `Friend ${s.latest} is available. Turn on automatic updates in Settings, or press Update now there.`
          : `Friend ${s.latest} is available. Close this Friend and run: friend upgrade`,
      );
    }
    if (this.d.auto() && canApply) await this.maybeApply();
  }

  private async maybeApply(): Promise<void> {
    const s = this.state();
    if (this.applying || !s.available || !s.latest) return;
    if (this.d.busy()) {
      if (!this.retry) {
        this.retry = setTimeout(() => {
          this.retry = null;
          void this.maybeApply();
        }, this.retryMs);
        this.retry.unref?.();
      }
      return;
    }
    await this.begin(s.latest);
  }

  private async begin(version: string): Promise<boolean> {
    this.applying = true;
    this.error = null;
    this.d.notify(`Updating Friend to ${version}. It restarts in a moment: reload this page afterwards.`);
    let ok = false;
    try {
      ok = await this.d.apply(version);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.applying = false;
      this.error = "Could not start the update.";
    }
    return ok;
  }
}
