import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeRunnerMode } from "./config";
import { runInSandbox, SandboxUnavailable, type SandboxInput, type SandboxResult } from "./sandbox";

export const MAX_CODE_CHARS = 50_000;
export const MAX_OUTPUT_CHARS = 20_000;
const MAX_EXTRA_FILES = 10;
const MAX_EXTRA_FILE_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export type Language = "python" | "node" | "shell";

const SETUP: Record<Language, { image: string; file: string; command: string[] }> = {
  python: { image: "python:3.12-alpine", file: "main.py", command: ["python", "-I"] },
  node: { image: "node:22-alpine", file: "main.js", command: ["node"] },
  shell: { image: "alpine:3.20", file: "main.sh", command: ["sh"] },
};

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type DockerExec = (args: string[], opts: { timeoutMs: number }) => Promise<DockerResult>;

export type RunResult =
  | { ok: true; runner?: "sandbox" | "docker"; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
  | { ok: false; error: string };

/** The real docker command line. A timeout stops that one container by name. */
export const spawnDocker: DockerExec = (args, { timeoutMs }) =>
  new Promise<DockerResult>((resolve, reject) => {
    const name = args[args.indexOf("--name") + 1];
    const child = spawn("docker", args, { windowsHide: true });
    const cap = MAX_OUTPUT_CHARS * 2; // keep memory bounded even if the program prints without end
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => void (stdout.length < cap && (stdout += d)));
    child.stderr.on("data", (d) => void (stderr.length < cap && (stderr += d)));
    // Removes a container by name whatever state it is in: running, or only created because the time ran out while
    // docker was still starting it (--rm does not clean up a container that never ran).
    const remove = () =>
      new Promise<void>((done) => {
        if (!name) return done();
        const rm = spawn("docker", ["rm", "-f", name], { windowsHide: true, stdio: "ignore" });
        rm.on("error", () => done());
        rm.on("close", () => done());
      });
    const timer = setTimeout(() => {
      timedOut = true;
      void remove(); // stops a running program straight away
      child.kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // the CLI is gone now, so nothing can create the container after this removal
      if (timedOut) void remove().then(() => resolve({ code, stdout, stderr, timedOut }));
      else resolve({ code, stdout, stderr, timedOut });
    });
  });

const clip = (s: string) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n[output cut]` : s);

const DOCKER_RETRY_MS = 60_000;

export interface CodeBoxOptions {
  /** Where code runs: docker (the default, as before), sandbox (the one built into Friend) or auto (Docker if it works, otherwise the sandbox). */
  mode?: () => CodeRunnerMode;
  /** The built-in sandbox. Replaced in tests. */
  sandbox?: (input: SandboxInput) => Promise<SandboxResult>;
  now?: () => number;
}

/**
 * Runs code the agent wrote, away from the owner's PC. Either inside a throwaway Docker container (no network, no access to the owner's
 * files, a read-only root, no capabilities and small CPU, memory and process limits) or in the sandbox built into Friend, which needs
 * nothing installed. The setting codeRunner picks; with auto, Docker is used when it works.
 */
export class CodeBox {
  private dockerDownUntil = 0;

  constructor(private docker: DockerExec = spawnDocker, private opts: CodeBoxOptions = {}) {}

  async run(input: { language: Language; code: string; timeoutSec?: number; files?: Record<string, string> }): Promise<RunResult> {
    if (!input.code.trim()) return { ok: false, error: "There is no code to run." };
    if (input.code.length > MAX_CODE_CHARS) return { ok: false, error: `The code is too long (the limit is ${MAX_CODE_CHARS} characters).` };
    const extra = Object.entries(input.files ?? {});
    if (extra.length > MAX_EXTRA_FILES) return { ok: false, error: "Too many files for the sandbox." };
    // plain names only: nothing can be written outside the code folder or replace the program itself
    if (extra.some(([n]) => !/^[A-Za-z0-9_.-]{1,64}$/.test(n) || n.startsWith("..") || Object.values(SETUP).some((s) => s.file === n))) {
      return { ok: false, error: "That file name is not allowed in the sandbox." };
    }
    if (extra.reduce((sum, [, body]) => sum + body.length, 0) > MAX_EXTRA_FILE_CHARS) return { ok: false, error: "The sandbox files are too large." };
    const timeoutMs = input.timeoutSec && input.timeoutSec > 0 ? Math.min(input.timeoutSec * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    const mode = this.opts.mode?.() ?? "docker";
    if (mode === "sandbox") return this.inSandbox(input, timeoutMs);
    const now = this.opts.now ?? Date.now;
    if (mode === "auto" && now() < this.dockerDownUntil) return this.inSandbox(input, timeoutMs);
    const viaDocker = await this.inDocker(input, timeoutMs);
    if (viaDocker.unavailable && mode === "auto") {
      this.dockerDownUntil = now() + DOCKER_RETRY_MS;
      return this.inSandbox(input, timeoutMs);
    }
    return viaDocker.result;
  }

  private async inSandbox(input: { language: Language; code: string; files?: Record<string, string> }, timeoutMs: number): Promise<RunResult> {
    try {
      const r = await (this.opts.sandbox ?? runInSandbox)({ language: input.language, code: input.code, files: input.files ?? {}, timeoutMs });
      const memory = "The program ran out of memory (limit 512 MB)." + String.fromCharCode(10);
      const stderr = r.outOfMemory ? (r.stderr && !r.stderr.endsWith(String.fromCharCode(10)) ? r.stderr + String.fromCharCode(10) : r.stderr) + memory : r.stderr;
      return { ok: true, runner: "sandbox", exitCode: r.code, stdout: clip(r.stdout), stderr: clip(stderr), timedOut: r.timedOut };
    } catch (e) {
      if (e instanceof SandboxUnavailable) return { ok: false, error: e.message };
      return { ok: false, error: "The built-in sandbox could not run this." };
    }
  }

  private async inDocker(input: { language: Language; code: string; files?: Record<string, string> }, timeoutMs: number): Promise<{ result: RunResult; unavailable: boolean }> {
    const extra = Object.entries(input.files ?? {});
    const setup = SETUP[input.language];
    const dir = mkdtempSync(join(tmpdir(), "friend-code-"));
    try {
      const file = join(dir, setup.file);
      writeFileSync(file, input.code);
      chmodSync(dir, 0o755); // the container's unprivileged user must be able to read it
      chmodSync(file, 0o644);
      for (const [name, body] of extra) {
        writeFileSync(join(dir, name), body);
        chmodSync(join(dir, name), 0o644);
      }
      const args = [
        "run", "--rm",
        "--name", `friend-run-${randomUUID()}`,
        "--network", "none",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--memory", "512m",
        "--memory-swap", "512m",
        "--cpus", "1",
        "--pids-limit", "128",
        "--user", "65534:65534",
        "-v", `${dir}:/work:ro`,
        "-w", "/work",
        setup.image,
        ...setup.command,
        `/work/${setup.file}`,
      ];
      let r: DockerResult;
      try {
        r = await this.docker(args, { timeoutMs });
      } catch (e) {
        if ((e as { code?: string }).code === "ENOENT") {
          return { result: { ok: false, error: "Docker is not available. Install Docker Desktop and start it to run code safely." }, unavailable: true };
        }
        return { result: { ok: false, error: "Docker could not be started." }, unavailable: true };
      }
      // exit code 125 means docker itself failed (not the program)
      if (r.code === 125 && !r.timedOut) {
        if (/daemon|pipe|socket/i.test(r.stderr)) return { result: { ok: false, error: "Docker is not running. Start Docker Desktop and try again." }, unavailable: true };
        return { result: { ok: false, error: "Docker could not start the container. The first run of each language needs an internet connection to download its image." }, unavailable: true };
      }
      return { result: { ok: true, runner: "docker", exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr), timedOut: r.timedOut }, unavailable: false };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
