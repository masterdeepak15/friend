import { connect } from "node:net";
import type { Audit } from "../audit";
import type { MailAutomationStore, MailWatch } from "./astore";
import { scheduleDue } from "./logic";
import { nextWatchState } from "./watchstate";

export interface AutomationDeps {
  store: MailAutomationStore;
  audit: Audit;
  now?: () => number;
  /** Whether the plugin is on. Nothing runs while it is off. */
  enabled: () => boolean;
  /** Starts an assistant turn for an instruction. False when the assistant is busy: it is offered again at the next tick. */
  run: (instruction: string, why: string) => Promise<boolean>;
  check?: (w: MailWatch) => Promise<{ ok: boolean; detail: string }>;
}

const TICK_MS = 30_000;

/** One check of a watch: a page that answers (and says what it should), or a port that accepts a connection. */
export async function checkWatch(w: MailWatch): Promise<{ ok: boolean; detail: string }> {
  if (w.kind === "tcp") {
    const [host, port] = w.target.split(":");
    return new Promise((resolve) => {
      const s = connect({ host: host ?? "", port: Number(port), timeout: 8000 });
      s.once("connect", () => (s.destroy(), resolve({ ok: true, detail: `${w.target} accepts connections` })));
      s.once("timeout", () => (s.destroy(), resolve({ ok: false, detail: `${w.target} did not answer in 8 seconds` })));
      s.once("error", (e) => resolve({ ok: false, detail: `${w.target}: ${(e as NodeJS.ErrnoException).code ?? "cannot connect"}` }));
    });
  }
  try {
    const res = await fetch(w.target, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    if (res.status >= 400) return { ok: false, detail: `HTTP ${res.status}` };
    if (w.expectText) {
      const text = (await res.text()).slice(0, 200_000);
      if (!text.includes(w.expectText)) return { ok: false, detail: `HTTP ${res.status} but the page does not contain "${w.expectText.slice(0, 60)}"` };
    }
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: `${(e as Error).name === "TimeoutError" ? "no answer in 10 seconds" : (e as Error).message.slice(0, 120)}` };
  }
}

/**
 * The owner's schedules and watches. A schedule wakes the assistant at its time. A watch is checked by plain code on its own interval and wakes
 * the assistant only when it changes (two failures in a row = down, one good answer = up), so watching costs nothing while all is well.
 */
export class MailAutomation {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Changes the assistant could not be told yet, because it was busy. */
  private waiting: { instruction: string; why: string }[] = [];

  constructor(private readonly d: AutomationDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy || !this.d.enabled()) return;
    this.busy = true;
    try {
      const now = (this.d.now ?? Date.now)();
      // what could not be told earlier goes first
      while (this.waiting.length) {
        const next = this.waiting[0]!;
        if (!(await this.d.run(next.instruction, next.why))) break;
        this.waiting.shift();
      }
      for (const s of this.d.store.listSchedules()) {
        if (!s.enabled || !scheduleDue(s.kind === "daily" ? { kind: "daily", at: s.at, lastRun: s.lastRun } : { kind: "every", minutes: s.minutes, lastRun: s.lastRun }, now)) continue;
        if (await this.d.run(s.instruction, `schedule ${s.name}`)) {
          this.d.store.markScheduleRun(s.id);
          this.d.audit.log("system", "mail.schedule_ran", { schedule: s.name });
        }
      }
      for (const w of this.d.store.listWatches()) {
        if (!w.enabled || now - w.lastCheck < w.intervalSec * 1000) continue;
        let result: { ok: boolean; detail: string };
        try {
          result = await (this.d.check ?? checkWatch)(w);
        } catch (e) {
          result = { ok: false, detail: `the check failed: ${(e as Error).message.slice(0, 120)}` };
        }
        const next = nextWatchState({ state: w.state, fails: w.fails }, result.ok);
        this.d.store.recordCheck(w.id, { state: next.state, fails: next.fails, detail: result.detail, changed: next.changed !== null });
        if (!next.changed) continue;
        const instruction = `Watch "${w.name}" (${w.target}) just went ${next.changed.toUpperCase()}: ${result.detail}.\n${w.instruction}`;
        this.d.audit.log("system", "mail.watch_changed", { watch: w.name, to: next.changed });
        if (!(await this.d.run(instruction, `watch ${w.name}`))) this.waiting.push({ instruction, why: `watch ${w.name}` });
      }
    } finally {
      this.busy = false;
    }
  }
}
