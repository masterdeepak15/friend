import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface SidecarOptions {
  command: string;
  args: string[];
  /** Shared secret; passed to the process as the FRIEND_VOICE_TOKEN environment variable. */
  token: string;
  readyTimeoutMs?: number;
  restartDelayMs?: number;
  maxRestarts?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs the Python sidecar, waits for its ready line, restarts it after a crash, and stops it cleanly. */
export class SidecarProcess {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private ready = false;
  private stopping = false;
  private noRestart = false;
  private restartCount = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";

  constructor(private opts: SidecarOptions) {}

  running(): boolean {
    return this.ready && this.child !== null && this.child.exitCode === null;
  }
  baseUrl(): string | null {
    return this.running() && this.port ? `http://127.0.0.1:${this.port}` : null;
  }
  restarts(): number {
    return this.restartCount;
  }

  /** Starts the process; resolves once it reports ready. A crash is handled by the restart policy. */
  start(): Promise<void> {
    this.stopping = false;
    return this.launch();
  }

  private launch(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      // The secret goes in the environment, not on the command line (other users can read command lines).
      const child = spawn(this.opts.command, this.opts.args, {
        cwd: this.opts.cwd,
        env: { ...(this.opts.env ?? process.env), FRIEND_VOICE_TOKEN: this.opts.token },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      this.ready = false;
      this.port = null;

      const timeoutMs = this.opts.readyTimeoutMs ?? 120_000;
      const timer = setTimeout(() => {
        this.noRestart = true;
        fail(`the voice sidecar did not become ready within ${timeoutMs} ms${this.tail()}`);
        child.kill();
      }, timeoutMs);

      child.stderr!.on("data", (d: Buffer) => {
        this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
      });
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (this.ready) return;
        try {
          const msg = JSON.parse(line) as { ready?: boolean; port?: number };
          if (msg.ready && typeof msg.port === "number") {
            this.port = msg.port;
            this.ready = true;
            clearTimeout(timer);
            settled = true;
            resolve();
          }
        } catch {
          /* ignore non-JSON output */
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        this.noRestart = true;
        this.child = null;
        fail(`could not start the voice sidecar: ${e.message}`);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        const wasReady = this.ready;
        this.ready = false;
        this.port = null;
        if (this.child === child) this.child = null;
        if (!wasReady) fail(`the voice sidecar exited (code ${code}) before it was ready${this.tail()}`);
        this.maybeRestart();
      });
    });
  }

  private tail(): string {
    return this.stderrTail ? `: ${this.stderrTail.trim().split("\n").slice(-3).join(" | ")}` : "";
  }

  private maybeRestart(): void {
    if (this.stopping || this.noRestart) return;
    const max = this.opts.maxRestarts ?? 1;
    if (this.restartCount >= max) return;
    this.restartCount += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.launch().catch(() => {});
    }, this.opts.restartDelayMs ?? 500);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill(), 3000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin?.end(); // the sidecar exits when its stdin closes
    });
  }
}
