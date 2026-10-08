import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface ProcOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type ProcItem =
  | { kind: "event"; ev: Record<string, any> }
  | { kind: "exit"; code: number | null; stderr: string; notInstalled: boolean };

const MAX_STDERR = 8 * 1024;

/**
 * One running `claude` process, spoken to in stream-json: a line of JSON in per user message, lines of JSON out as events.
 * cross-spawn is used instead of spawn with a shell: on Windows `claude` may be a .cmd file, and a shell would
 * re-interpret the arguments (the system prompt is long and arbitrary text).
 */
export class ClaudeProc {
  alive = true;
  readonly exited: Promise<void>;
  private child: ChildProcess;
  private buffer = "";
  private stderr = "";

  constructor(opts: ProcOptions, private emit: (item: ProcItem) => void) {
    this.child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.exited = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (code: number | null, notInstalled: boolean) => {
        if (finished) return;
        finished = true;
        this.alive = false;
        this.emit({ kind: "exit", code, stderr: this.stderr, notInstalled });
        resolve();
      };
      this.child.on("error", (e) => finish(null, (e as NodeJS.ErrnoException).code === "ENOENT"));
      this.child.on("close", (code) => finish(code, false));
    });
    this.child.stdin?.on("error", () => {}); // writing to a process that just ended is not an error worth crashing for
    this.child.stdout?.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    this.child.stderr?.on("data", (d: Buffer) => {
      if (this.stderr.length < MAX_STDERR) this.stderr += d.toString("utf8");
    });
  }

  /** Sends one user message (Anthropic-style content blocks). */
  send(content: unknown[]): void {
    if (!this.alive) return;
    this.child.stdin?.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }

  kill(): void {
    if (!this.alive) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    this.child.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      try {
        this.emit({ kind: "event", ev: JSON.parse(line) });
      } catch {
        /* a partial or unknown line must never stop the stream */
      }
    }
  }
}
