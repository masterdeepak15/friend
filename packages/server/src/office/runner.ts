import spawn from "cross-spawn";
import { ClaudeProc } from "../provider/claude-code/process";
import { parseWorkerEvent, type WorkerEvent } from "./events";

/** The name of the one tool a worker's MCP server offers: Claude Code asks it before any action it would otherwise ask about. */
export const APPROVE_TOOL = "mcp__office__approve";
/** A model name is a plain word, never something that could be read as a flag. */
const SAFE_MODEL = /^[A-Za-z0-9][\w.:/-]*$/;

export interface WorkerArgsInput {
  /** Already resolved: the role's model, or the default one. An unusable name leaves the flag out. */
  model: string;
  instructions: string;
  permission: "default" | "acceptEdits";
  mcpConfigPath: string;
  extraFolders: string[];
  resume?: string;
  sessionId?: string;
  /** The program's own leading arguments (the same ones the Claude Code provider uses). */
  commandArgs?: string[];
}

/**
 * The command line of one worker. It never carries --allowedTools (a tool on Claude Code's own allow-list skips Friend's gate),
 * never --dangerously-skip-permissions and never a permission mode that skips questions: Friend must see every action.
 * A value that starts with a dash is never passed where it could be read as a flag.
 */
export function buildWorkerArgs(o: WorkerArgsInput): string[] {
  const instructions = o.instructions.trim();
  return [
    ...(o.commandArgs ?? []),
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ...(SAFE_MODEL.test(o.model) ? ["--model", o.model] : []),
    "--permission-mode", o.permission,
    "--setting-sources", "local",
    "--strict-mcp-config", "--mcp-config", o.mcpConfigPath,
    "--permission-prompt-tool", APPROVE_TOOL,
    "--disable-slash-commands",
    ...(instructions ? ["--append-system-prompt", instructions.startsWith("-") ? `Instructions: ${instructions}` : instructions] : []),
    ...o.extraFolders.filter((f) => f !== "" && !f.startsWith("-")).flatMap((f) => ["--add-dir", f]),
    ...(o.resume ? ["--resume", o.resume] : o.sessionId ? ["--session-id", o.sessionId] : []),
  ];
}

export interface WorkerExit {
  code: number | null;
  stderr: string;
  notInstalled: boolean;
}

/** The environment a worker starts with: this one, without an API key or token, so Claude Code uses the signed-in subscription and never bills an API account. */
export function workerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)));
}
/** One running worker: a `claude` process spoken to in stream-json, whose output arrives as normalised events. */
export class WorkerProc {
  private proc: ClaudeProc;
  readonly exited: Promise<void>;

  constructor(o: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }, onEvent: (e: WorkerEvent) => void, onExit: (x: WorkerExit) => void) {
    this.proc = new ClaudeProc({ command: o.command, args: o.args, cwd: o.cwd, env: o.env ?? workerEnv(process.env) }, (item) => {
      if (item.kind === "event") for (const e of parseWorkerEvent(item.ev)) onEvent(e);
      else onExit({ code: item.code, stderr: item.stderr, notInstalled: item.notInstalled });
    });
    this.exited = this.proc.exited;
  }

  get alive(): boolean {
    return this.proc.alive;
  }

  /** Sends one more message to the worker's conversation. */
  send(text: string): void {
    this.proc.send([{ type: "text", text }]);
  }

  /** Stops the worker and everything it started. On Windows a program such as `claude.exe` leaves its children behind unless the whole tree is stopped. */
  kill(): void {
    if (!this.proc.alive) return;
    const pid = this.proc.pid;
    if (process.platform === "win32" && pid) {
      try {
        spawn.sync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 }); // finished before the root is killed, so the tree can still be walked
      } catch {
        /* the plain kill below still runs */
      }
    }
    this.proc.kill();
  }
}