import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export type FindResult = { found: true; path: string; version: string } | { found: false; install: string };

export interface FindDeps {
  /** What the owner set (a name or a path), or empty to look around. */
  program: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  run?: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
}

const INSTALL: Record<"win32" | "darwin" | "other", string> = {
  win32: "mpv is not installed. Install it once with: winget install mpv (or scoop install mpv, or choco install mpv), then try again.",
  darwin: "mpv is not installed. Install it once with: brew install mpv, then try again.",
  other: "mpv is not installed. Install it with your package manager, for example: sudo apt install mpv (Debian, Ubuntu), sudo dnf install mpv (Fedora) or sudo pacman -S mpv (Arch), then try again.",
};
const installFor = (p: NodeJS.Platform): string => (p === "win32" ? INSTALL.win32 : p === "darwin" ? INSTALL.darwin : INSTALL.other);

function defaultRun(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    let child: ChildProcess;
    try {
      child = nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, 5000);
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < 2000) out += d.toString();
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Where mpv usually is on each system, when it is not on the PATH. */
function places(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === "win32") {
    const w = path.win32;
    const out: string[] = [];
    if (env.ProgramFiles) out.push(w.join(env.ProgramFiles, "mpv", "mpv.exe"));
    if (env.LOCALAPPDATA) out.push(w.join(env.LOCALAPPDATA, "Programs", "mpv", "mpv.exe"), w.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "mpv.exe"));
    if (env.USERPROFILE) out.push(w.join(env.USERPROFILE, "scoop", "shims", "mpv.exe"));
    out.push("C:\\ProgramData\\chocolatey\\bin\\mpv.exe");
    return out;
  }
  if (platform === "darwin") return ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv", "/Applications/mpv.app/Contents/MacOS/mpv"];
  return ["/usr/bin/mpv", "/usr/local/bin/mpv", "/snap/bin/mpv"];
}

/**
 * Finds the owner's mpv: the program they set, or else `mpv` on the PATH, or else the usual places for their system. Friend never
 * installs anything: when it is not there the answer is one sentence saying how to install it.
 */
export async function findMpv(d: FindDeps): Promise<FindResult> {
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const exists = d.exists ?? existsSync;
  const run = d.run ?? defaultRun;
  const versionOf = async (p: string): Promise<string | null> => {
    const r = await run(p, ["--version"]);
    if (r.code !== 0) return null;
    const m = /^mpv\s+v?(\d[^\s]*)/i.exec(r.out.trim().split(/\r?\n/)[0] ?? "");
    return m ? m[1]! : null;
  };
  const isPath = (p: string) => /[\\/]/.test(p);
  const tryOne = async (p: string): Promise<FindResult | null> => {
    if (isPath(p) && !exists(p)) return null;
    const v = await versionOf(p);
    return v ? { found: true, path: p, version: v } : null;
  };
  const set = d.program.trim();
  if (set) {
    return (await tryOne(set)) ?? { found: false, install: `The program set in Settings is not mpv, or does not start. Use mpv, or clear the setting so Friend can look for it. ${installFor(platform)}` };
  }
  for (const c of ["mpv", ...places(platform, env)]) {
    const r = await tryOne(c);
    if (r) return r;
  }
  return { found: false, install: installFor(platform) };
}

export type MpvEvent =
  | { type: "time"; position: number; duration: number }
  | { type: "paused"; paused: boolean }
  | { type: "ended" }
  | { type: "failed"; reason: string }
  | { type: "exited" };

export interface MpvDeps {
  /** The program the owner set (empty: find it). */
  program: () => string;
  dataDir: string;
  spawn?: typeof nodeSpawn;
  /** For tests: stands in for findMpv. */
  resolve?: () => Promise<FindResult>;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  /** Replaces the command line mpv is started with (the video window needs a window and yt-dlp; the music player must not have them). */
  argv?: (pipe: string) => string[];
}

let counter = 0;

/**
 * Drives the owner's mpv through its JSON IPC. mpv is started once, kept idle, and told what to do: a file is loaded through the
 * IPC (never as a command-line argument, so a file name can never act as an option). Friend ships no decoder; mpv is the owner's.
 */
export class Mpv {
  private child: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private pipe: string | null = null;
  private starting: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
  private listeners = new Set<(e: MpvEvent) => void>();
  private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private pos = 0;
  private dur = 0;
  private disposed = false;
  private onProcessExit = () => this.child?.kill();

  constructor(private d: MpvDeps) {}

  onEvent(fn: (e: MpvEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(e: MpvEvent): void {
    for (const f of this.listeners) f(e);
  }

  async start(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.disposed) return { ok: false, error: "mpv has been stopped." };
    if (this.sock && this.child) return { ok: true };
    if (!this.starting) this.starting = this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private pipePath(): string {
    const name = `friend-mpv-${process.pid}-${++counter}`;
    if (process.platform === "win32") return `\\\\.\\pipe\\${name}`;
    const inData = path.join(this.d.dataDir, `${name}.sock`);
    return inData.length < 100 ? inData : path.join(tmpdir(), `${name}.sock`); // unix socket paths are short
  }

  private async doStart(): Promise<{ ok: true } | { ok: false; error: string }> {
    const found = await (this.d.resolve ?? (() => findMpv({ program: this.d.program() })))();
    if (!found.found) return { ok: false, error: found.install };
    const pipe = this.pipePath();
    let child: ChildProcess;
    try {
      const args = this.d.argv ? this.d.argv(pipe) : ["--no-video", "--idle=yes", "--no-terminal", "--force-window=no", "--ytdl=no", "--load-scripts=no", "--access-references=no", "--tls-verify=yes", `--input-ipc-server=${pipe}`];
      child = (this.d.spawn ?? nodeSpawn)(found.path, args, { stdio: "ignore", windowsHide: true });
    } catch {
      return { ok: false, error: "mpv could not be started." };
    }
    this.child = child;
    this.pipe = pipe;
    process.once("exit", this.onProcessExit);
    let died = false;
    child.on("error", () => (died = true));
    child.on("exit", () => {
      died = true;
      this.onExit(child);
    });
    const deadline = Date.now() + (this.d.connectTimeoutMs ?? 5000);
    let sock: net.Socket | null = null;
    while (!sock && !died && Date.now() < deadline) {
      sock = await new Promise<net.Socket | null>((resolve) => {
        const s = net.connect(pipe);
        s.once("connect", () => resolve(s));
        s.once("error", () => {
          s.destroy();
          setTimeout(() => resolve(null), 50);
        });
      });
    }
    if (!sock || died) {
      this.cleanup(child);
      return { ok: false, error: "mpv started but Friend could not talk to it." };
    }
    this.sock = sock;
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    sock.on("close", () => this.onExit(child));
    sock.on("error", () => {});
    try {
      await this.request(["observe_property", 1, "time-pos"]);
      await this.request(["observe_property", 2, "duration"]);
      await this.request(["observe_property", 3, "pause"]);
    } catch {
      this.cleanup(child);
      return { ok: false, error: "mpv started but did not answer." };
    }
    return { ok: true };
  }

  private onLine(line: string): void {
    let m: { request_id?: number; error?: string; event?: string; name?: string; data?: unknown; reason?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof m.request_id === "number") {
      const p = this.pending.get(m.request_id);
      if (!p) return;
      this.pending.delete(m.request_id);
      clearTimeout(p.timer);
      if (m.error === "success") p.resolve();
      else p.reject(new Error("mpv could not do that."));
      return;
    }
    if (m.event === "property-change") {
      if (m.name === "time-pos" && typeof m.data === "number") {
        this.pos = m.data;
        this.emit({ type: "time", position: this.pos, duration: this.dur });
      } else if (m.name === "duration" && typeof m.data === "number") {
        this.dur = m.data;
        this.emit({ type: "time", position: this.pos, duration: this.dur });
      } else if (m.name === "pause" && typeof m.data === "boolean") this.emit({ type: "paused", paused: m.data });
    } else if (m.event === "end-file") {
      if (m.reason === "eof") this.emit({ type: "ended" });
      else if (m.reason === "error") this.emit({ type: "failed", reason: "mpv could not open or play that file." });
    }
  }

  private request(command: unknown[]): Promise<void> {
    const sock = this.sock;
    if (!sock) return Promise.reject(new Error("mpv is not running."));
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("mpv did not answer."));
      }, this.d.requestTimeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, timer });
      sock.write(`${JSON.stringify({ command, request_id: id })}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error("mpv is not running."));
        }
      });
    });
  }

  private async cmd(command: unknown[]): Promise<void> {
    const r = await this.start();
    if (!r.ok) throw new Error(r.error);
    await this.request(command);
  }

  /** Any command mpv understands (a property to set, for example), started with mpv if it is not running yet. */
  send(command: unknown[]): Promise<void> {
    return this.cmd(command);
  }

  async load(file: string): Promise<void> {
    await this.cmd(["loadfile", file, "replace"]);
    await this.request(["set_property", "pause", false]);
  }
  pause(on: boolean): Promise<void> {
    return this.cmd(["set_property", "pause", on]);
  }
  seek(seconds: number): Promise<void> {
    return this.cmd(["seek", seconds, "absolute"]);
  }
  volume(percent: number): Promise<void> {
    return this.cmd(["set_property", "volume", percent]);
  }
  mute(on: boolean): Promise<void> {
    return this.cmd(["set_property", "mute", on]);
  }
  stop(): Promise<void> {
    return this.cmd(["stop"]);
  }

  private onExit(child: ChildProcess): void {
    if (this.child !== child) return;
    this.cleanup(child);
    if (!this.disposed) this.emit({ type: "exited" });
  }

  private cleanup(child: ChildProcess): void {
    if (this.child === child) {
      this.child = null;
      this.sock?.destroy();
      this.sock = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("mpv closed."));
      }
      this.pending.clear();
      if (this.pipe && process.platform !== "win32") rmSync(this.pipe, { force: true });
      this.pipe = null;
      process.off("exit", this.onProcessExit);
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }

  /** Ends the running mpv (if any) so the next call starts a fresh one, for example with another program. The listeners stay. */
  reset(): void {
    if (this.child) this.cleanup(this.child);
  }

  /** Ends mpv and forgets it. Nothing is left running. */
  dispose(): void {
    this.disposed = true;
    if (this.child) this.cleanup(this.child);
    this.listeners.clear();
  }
}
