import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELPER_PS1 } from "./helperScript.gen";

export interface HelperResult {
  text: string;
  image?: { mime: string; data: string; scale?: number };
}

/** The part of a child process the helper uses (so tests can use a fake). */
export interface ChildLike {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

export interface HelperOptions {
  spawn(): ChildLike;
  /** How long one call may take before the helper is restarted (default 60 s). */
  timeoutMs?: number;
  /** What the helper reports on its own: "human" (the person used the mouse or keyboard), "hotkey", "term.output"... */
  onEvent?(event: string, data: Record<string, unknown>): void;
}

interface Pending {
  resolve(r: HelperResult): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/** The Windows helper: one long-lived PowerShell process that does everything that needs Windows. Calls go in as JSON lines and come back the same way. */
export class Helper {
  private child: ChildLike | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private stopped = false;

  constructor(private readonly opts: HelperOptions) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const child = this.opts.spawn();
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("The Windows helper did not start in time."));
        this.kill();
      }, 45_000);
      child.onLine((line) => {
        if (this.child !== child) return;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // a line that is not ours (a warning printed by PowerShell)
        }
        if (m.event === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (typeof m.event === "string") this.opts.onEvent?.(m.event, m);
        else if (typeof m.id === "number") this.answer(m);
      });
      child.onExit(() => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        reject(new Error("The Windows helper stopped."));
        this.failAll("The Windows helper stopped.");
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  private answer(m: Record<string, unknown>): void {
    const p = this.pending.get(m.id as number);
    if (!p) return;
    this.pending.delete(m.id as number);
    clearTimeout(p.timer);
    if (m.ok === true) {
      const r = (m.result ?? {}) as { text?: unknown; image?: HelperResult["image"] };
      p.resolve({ text: typeof r.text === "string" ? r.text : JSON.stringify(m.result), ...(r.image ? { image: r.image } : {}) });
    } else p.reject(new Error(typeof m.error === "string" ? m.error : "The helper failed."));
  }

  private failAll(why: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(why));
    }
  }

  private kill(): void {
    const c = this.child;
    this.child = null;
    this.ready = null;
    try {
      c?.kill();
    } catch {
      /* gone already */
    }
  }

  /** Does something on the PC. The helper starts on the first call (a few seconds) and is started again if it ever stops. */
  async call(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<HelperResult> {
    if (this.stopped) throw new Error("The Windows helper is stopped.");
    await this.start();
    const child = this.child;
    if (!child) throw new Error("The Windows helper is not running.");
    const id = ++this.seq;
    return new Promise<HelperResult>((resolve, reject) => {
      const ms = timeoutMs ?? this.opts.timeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The PC did not answer ${op} within ${Math.round(ms / 1000)} seconds. The helper was restarted.`));
        this.kill();
        this.failAll("The Windows helper was restarted.");
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      child.write(`${JSON.stringify({ id, op, args })}\n`);
    });
  }

  stop(): void {
    this.stopped = true;
    this.kill();
    this.failAll("The Windows helper is stopped.");
  }
}

/** Writes the helper script into a folder and returns a spawner for Windows PowerShell 5.1 (which every Windows 10 and 11 has). */
export function powershellSpawner(dir: string): () => ChildLike {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "helper.ps1");
  writeFileSync(script, HELPER_PS1, "utf8");
  return () => {
    const p = nodeSpawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.setEncoding("utf8");
    p.stderr.resume();
    let buf = "";
    return {
      write: (line) => void p.stdin.write(line, "utf8"),
      onLine: (cb) =>
        p.stdout.on("data", (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            cb(buf.slice(0, i).replace(/\r$/, ""));
            buf = buf.slice(i + 1);
          }
        }),
      onExit: (cb) => void p.on("exit", cb),
      kill: () => void p.kill(),
    };
  };
}
