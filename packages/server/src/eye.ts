import type { Audit } from "./audit";
import type { Config } from "./config";

/**
 * The eye: while it is on, the assistant may look through the camera without asking each time (see eyeGate.ts for who and how often).
 * It is off by default, only the owner at the screen turns it on, and it turns itself off when the time the owner chose has passed,
 * when the owner signs out, and whenever Friend starts again.
 */
export class Eye {
  private wasOn = false;
  private since = 0;
  private reason = "owner";

  constructor(
    private d: {
      config: () => Config;
      clock?: () => number;
      /** Saves the switch (in the running settings and in the file). */
      persist: (on: boolean) => void;
      audit: Pick<Audit, "log">;
      /** Whether anybody is signed in. The eye closes when nobody is (the sessions ran out, or were all ended). */
      anySession?: () => boolean;
    },
  ) {
    // an eye left on in the file by a crash or a power cut is not trusted: it starts closed
    if (d.config().eye.on) this.switchOff("restart");
  }

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  isOn(): boolean {
    return this.d.config().eye.on;
  }

  /** Looks at the switch and writes down a change; also ends the eye when its time is up. Called after every settings change and every half minute. */
  sync(): void {
    const cfg = this.d.config().eye;
    if (cfg.on && !this.wasOn) {
      this.since = this.now();
      this.wasOn = true;
      this.d.audit.log("owner", "eye.on", { autoOffMinutes: cfg.autoOffMinutes });
    } else if (!cfg.on && this.wasOn) {
      this.wasOn = false;
      this.d.audit.log("owner", "eye.off", { reason: this.reason });
      this.reason = "owner";
    }
    if (cfg.on && this.d.anySession && !this.d.anySession()) return this.switchOff("no session");
    if (cfg.on && cfg.autoOffMinutes > 0 && this.now() - this.since >= cfg.autoOffMinutes * 60_000) this.switchOff("timeout");
  }

  switchOff(reason: string): void {
    if (!this.d.config().eye.on) return;
    this.reason = reason;
    this.d.persist(false);
    this.sync();
    // an eye that was never seen on (restart) has nothing to log through sync: say it here
    if (this.reason === reason && reason === "restart") {
      this.d.audit.log("system", "eye.off", { reason });
      this.reason = "owner";
    }
  }
}
