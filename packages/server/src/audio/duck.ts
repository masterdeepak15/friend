export interface DuckDeps {
  /** The owner's switch for turning music and video down. */
  enabled: () => boolean;
  /** How loud they are then, as a percent of how loud they were. */
  percent: () => number;
  /** Told whenever the level changes: 1 is as it is, 0.25 is a quarter as loud. */
  apply: (level: number) => void;
}

const FALLBACK_PERCENT = 25;

/**
 * Decides how loud music and video should be. Screens say they are listening to the owner or that Friend is speaking; while
 * any of them says so, the sound is turned down, and when none does it is back to normal. A screen that goes away takes its
 * claim with it, so sound is never left turned down.
 */
export class DuckController {
  private active = new Set<string>();
  private current = 1;

  constructor(private d: DuckDeps) {}

  /** How loud things should be now: 1 as normal. */
  get level(): number {
    return this.current;
  }

  set(source: string, active: boolean): void {
    if (active) this.active.add(source);
    else this.active.delete(source);
    this.update();
  }

  /** A screen went away. */
  drop(source: string): void {
    if (this.active.delete(source)) this.update();
  }

  /** The owner changed the settings. */
  refresh(): void {
    this.update();
  }

  private update(): void {
    const raw = this.d.percent();
    const percent = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : FALLBACK_PERCENT;
    const next = this.d.enabled() && this.active.size > 0 ? percent / 100 : 1;
    if (next === this.current) return;
    this.current = next;
    this.d.apply(next);
  }
}
