import { insideFolders, type PcPermissions } from "@friend/protocol";
import * as xtermModule from "@xterm/headless";
import { homedir } from "node:os";
import { claudeSessions } from "./claude";
import type { Helper } from "./helper";
import { isCancel, keyBytes, readScreen, trimScreen, type ScreenReading } from "./termScreen";
import type { TerminalTools, ToolOutcome } from "./tools";

interface XTerm {
  write(data: string | Uint8Array, cb?: () => void): void;
  dispose(): void;
  readonly rows: number;
  readonly buffer: { readonly active: { readonly baseY: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } };
}
type XTermCtor = new (options: Record<string, unknown>) => XTerm;
const Terminal = ((xtermModule as unknown as { Terminal?: XTermCtor; default?: { Terminal: XTermCtor } }).Terminal ?? (xtermModule as unknown as { default: { Terminal: XTermCtor } }).default.Terminal) as XTermCtor;

const COLS = 120;
const ROWS = 40;
const MAX_SESSIONS = 6;
/** Flags that would let a program skip the permission prompts the owner counts on. */
const FORBIDDEN_FLAGS = /dangerously|bypass-?permissions|--yolo|permission-mode[= ]+bypass/i;

export interface TermsDeps {
  helper: Pick<Helper, "call">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Where Claude Code keeps its sessions (the user's home folder). */
  home?: string;
  /** How many terminals are open, for the status line. */
  onCount?: (n: number) => void;
}

interface Session {
  id: string;
  label: string;
  cwd: string;
  term: XTerm;
  lastOutput: number;
  exitCode: number | null;
  writing: Promise<void>;
}

const quote = (s: string): string => (/[\s"&|<>^]/.test(s) || s === "" ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The command line for a terminal: Claude Code (new, continued or resumed), a PowerShell, or any other program (through cmd, so shims such as claude.cmd work). */
export function commandLine(command: string, args: string[], opts: { resume?: boolean | string | undefined; continue?: boolean | undefined }): { cmdline: string; label: string } | { error: string } {
  const all = [...args];
  if (all.some((a) => FORBIDDEN_FLAGS.test(a))) return { error: "That flag would skip the permission prompts. It is not allowed." };
  const c = (command || "shell").trim();
  if (/^(shell|powershell)$/i.test(c)) return { cmdline: "powershell.exe -NoLogo", label: "PowerShell" };
  if (/^claude(\.exe|\.cmd)?$/i.test(c)) {
    if (typeof opts.resume === "string") {
      if (!/^[A-Za-z0-9-]{8,64}$/.test(opts.resume)) return { error: "That is not a session id. List them with pc.claude.sessions." };
      all.unshift("--resume", opts.resume);
    } else if (opts.resume === true || opts.continue) all.unshift("--continue");
    return { cmdline: `cmd.exe /d /c claude${all.length ? ` ${all.map(quote).join(" ")}` : ""}`, label: "claude" };
  }
  if (/[\\/]/.test(c) && /\.\./.test(c)) return { error: "That program path is not allowed." };
  return { cmdline: `cmd.exe /d /c ${quote(c)}${all.length ? ` ${all.map(quote).join(" ")}` : ""}`, label: c };
}

/** The terminal sessions of this PC. Each one is a real program on a pseudo console; its output is kept as a screen the assistant can read, and its input is real key presses. */
export class Terms implements TerminalTools {
  private sessions = new Map<string, Session>();
  private seq = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: TermsDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** What the helper reports: bytes from a program, or that it ended. */
  onEvent(event: string, data: Record<string, unknown>): void {
    const s = typeof data.id === "string" ? this.sessions.get(data.id) : undefined;
    if (!s) return;
    if (event === "term.output" && typeof data.data === "string") {
      s.lastOutput = this.now();
      s.writing = s.writing.then(() => new Promise<void>((resolve) => s.term.write(Buffer.from(data.data as string, "base64"), resolve)));
    } else if (event === "term.exit") {
      s.exitCode = typeof data.code === "number" ? data.code : 0;
      s.lastOutput = this.now();
      this.count();
    }
  }

  count(): number {
    const n = [...this.sessions.values()].filter((s) => s.exitCode === null).length;
    this.deps.onCount?.(n);
    return n;
  }

  /** Ends every terminal (the agent is stopping, or was revoked). */
  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.close(id);
  }

  private async lines(s: Session): Promise<string[]> {
    await s.writing;
    const b = s.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < s.term.rows; y++) out.push(b.getLine(b.baseY + y)?.translateToString(true) ?? "");
    return trimScreen(out);
  }

  private async reading(s: Session): Promise<{ lines: string[]; r: ScreenReading }> {
    const lines = await this.lines(s);
    return { lines, r: readScreen(lines, this.now() - s.lastOutput, s.exitCode !== null) };
  }

  private render(s: Session, lines: string[], r: ScreenReading, last?: number): string {
    const shown = last ? lines.slice(-last) : lines;
    const head = `[${s.id} ${s.label} in ${s.cwd} | ${r.state}${s.exitCode !== null ? ` (exit code ${s.exitCode})` : ""}]`;
    const opts = r.options.length ? `\nOptions: ${r.options.map((o) => `${o.n !== null ? `${o.n}. ` : ""}${o.text}${o.selected ? " <- cursor" : ""}`).join(" | ")}` : "";
    const q = r.state === "prompt" && r.question ? `\nAsking: ${r.question}${r.destructive ? "\nThis looks destructive or risky: the owner decides, not you." : ""}` : "";
    return `${head}\n${shown.join("\n") || "(empty screen)"}${opts}${q}`;
  }

  async run(name: string, a: Record<string, unknown>, perms: PcPermissions, approved: boolean): Promise<ToolOutcome> {
    try {
      switch (name) {
        case "pc.term.open":
          return await this.open(a, perms);
        case "pc.term.list":
          return this.list();
        case "pc.term.read":
          return await this.read(a);
        case "pc.term.send":
          return await this.send(a, approved);
        case "pc.term.wait":
          return await this.waitFor(a);
        case "pc.term.close":
          await this.close(String(a.id));
          return { ok: true, output: `Closed ${String(a.id)}.`, truncated: false };
        case "pc.claude.sessions": {
          const project = String(a.project ?? "");
          if (!insideFolders(project, perms.folders)) return { ok: false, error: "That project is outside the folders the owner allowed." };
          const found = await claudeSessions(project, this.deps.home ?? homedir());
          return { ok: true, truncated: false, output: found.length ? found.map((x) => `${x.id} | ${new Date(x.at).toISOString().slice(0, 16).replace("T", " ")} | ${x.summary || "(no summary)"}`).join("\n") : "No earlier Claude Code sessions for that project." };
        }
        default:
          return { ok: false, error: `Unknown terminal tool: ${name}` };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async open(a: Record<string, unknown>, perms: PcPermissions): Promise<ToolOutcome> {
    if (!perms.shell) return { ok: false, error: "The owner has not given this PC the shell permission." };
    const cwd = typeof a.cwd === "string" ? a.cwd : "";
    if (!cwd || !insideFolders(cwd, perms.folders)) return { ok: false, error: "A terminal opens in one of the folders the owner allowed." };
    if (this.count() >= MAX_SESSIONS) return { ok: false, error: `There are ${MAX_SESSIONS} terminals open already. Close one first.` };
    const c = commandLine(typeof a.command === "string" ? a.command : "shell", Array.isArray(a.args) ? a.args.map(String) : [], { resume: a.resume as boolean | string | undefined, continue: a.continue === true });
    if ("error" in c) return { ok: false, error: c.error };
    const id = `t${++this.seq}`;
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
    const s: Session = { id, label: c.label, cwd, term, lastOutput: 0, exitCode: null, writing: Promise.resolve() };
    this.sessions.set(id, s);
    try {
      await this.deps.helper.call("term.open", { id, cwd, cmdline: c.cmdline, cols: COLS, rows: ROWS });
    } catch (e) {
      this.sessions.delete(id);
      term.dispose();
      return { ok: false, error: (e as Error).message };
    }
    this.count();
    for (let i = 0; i < 40 && s.lastOutput === 0; i++) await this.sleep(100); // wait for the first words of the program
    await this.sleep(500);
    const { lines, r } = await this.reading(s);
    return { ok: true, truncated: false, output: `Opened ${id}. ${this.render(s, lines, r, 40)}` };
  }

  private list(): ToolOutcome {
    const all = [...this.sessions.values()];
    return { ok: true, truncated: false, output: all.length ? all.map((s) => `${s.id}: ${s.label} in ${s.cwd}, ${s.exitCode === null ? "running" : `ended (exit code ${s.exitCode})`}`).join("\n") : "No terminals are open." };
  }

  private get(id: unknown): Session {
    const s = this.sessions.get(String(id));
    if (!s) throw new Error(`There is no terminal ${String(id)}. Open one with pc.term.open, or see pc.term.list.`);
    return s;
  }

  private async read(a: Record<string, unknown>): Promise<ToolOutcome> {
    const s = this.get(a.id);
    const { lines, r } = await this.reading(s);
    return { ok: true, truncated: false, output: this.render(s, lines, r, typeof a.lines === "number" ? a.lines : undefined) };
  }

  private async send(a: Record<string, unknown>, approved: boolean): Promise<ToolOutcome> {
    const s = this.get(a.id);
    if (s.exitCode !== null) return { ok: false, error: `${s.id} has ended (exit code ${s.exitCode}). Open a new terminal.` };
    const text = typeof a.text === "string" ? a.text : "";
    const keys = Array.isArray(a.keys) ? a.keys.map(String) : [];
    const { lines, r } = await this.reading(s);
    const onlyCancel = !text && !a.enter && keys.length > 0 && keys.every(isCancel);
    if (r.state === "prompt" && r.destructive && !approved && !onlyCancel) {
      return { ok: false, error: "The terminal is asking about something risky. The owner has to approve answering it.", needsApproval: { reason: `The terminal asks: ${r.question.slice(0, 200)}`, detail: lines.slice(-14).join("\n").slice(0, 1200) } };
    }
    const write = (data: string): Promise<unknown> => this.deps.helper.call("term.write", { id: s.id, data: Buffer.from(data, "utf8").toString("base64") });
    if (text) {
      await write(text);
      await this.sleep(150); // typed first, submitted after: some programs treat text and Enter that arrive together as a paste
    }
    if (a.enter === true) await write("\r");
    for (const k of keys) {
      await write(keyBytes(k));
      await this.sleep(80);
    }
    s.lastOutput = this.now();
    await this.sleep(600);
    const after = await this.reading(s);
    return { ok: true, truncated: false, output: `Sent${text ? ` ${text.length} characters` : ""}${a.enter === true ? " and Enter" : ""}${keys.length ? ` keys ${keys.join(" ")}` : ""}.\n${this.render(s, after.lines, after.r, 30)}` };
  }

  private async waitFor(a: Record<string, unknown>): Promise<ToolOutcome> {
    const s = this.get(a.id);
    const until = a.until === "text" ? "text" : "idle";
    const needle = typeof a.text === "string" ? a.text.toLowerCase() : "";
    const deadline = this.now() + (typeof a.timeout === "number" ? a.timeout : 60) * 1000;
    for (;;) {
      const { lines, r } = await this.reading(s);
      const quiet = this.now() - s.lastOutput;
      const hit = until === "text" ? needle !== "" && lines.join("\n").toLowerCase().includes(needle) : r.state === "prompt" || r.state === "exited" || (r.state === "idle" && quiet >= 2000);
      if (hit) return { ok: true, truncated: false, output: this.render(s, lines, r, 40) };
      if (this.now() >= deadline) return { ok: true, truncated: false, output: `Still not ${until === "text" ? `showing "${a.text}"` : "idle"} after the time limit.\n${this.render(s, lines, r, 40)}` };
      await this.sleep(300);
    }
  }

  private async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await this.deps.helper.call("term.close", { id }).catch(() => {});
    s.term.dispose();
    this.count();
  }
}
