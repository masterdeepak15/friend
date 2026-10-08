import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_CODE_CHARS = 50_000;
export const MAX_OUTPUT_CHARS = 20_000;
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
  | { ok: true; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
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
    const timer = setTimeout(() => {
      timedOut = true;
      if (name) spawn("docker", ["kill", name], { windowsHide: true }).on("error", () => {});
      child.kill();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

const clip = (s: string) => (s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n[output cut]` : s);

/**
 * Runs code the agent wrote inside a throwaway container with no network, no access to the owner's files, a read-only
 * root, no capabilities and small CPU, memory and process limits. Needs Docker; without it nothing runs.
 */
export class CodeBox {
  constructor(private docker: DockerExec = spawnDocker) {}

  async run(input: { language: Language; code: string; timeoutSec?: number }): Promise<RunResult> {
    if (!input.code.trim()) return { ok: false, error: "There is no code to run." };
    if (input.code.length > MAX_CODE_CHARS) return { ok: false, error: `The code is too long (the limit is ${MAX_CODE_CHARS} characters).` };
    const setup = SETUP[input.language];
    const timeoutMs = input.timeoutSec && input.timeoutSec > 0 ? Math.min(input.timeoutSec * 1000, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    const dir = mkdtempSync(join(tmpdir(), "friend-code-"));
    try {
      const file = join(dir, setup.file);
      writeFileSync(file, input.code);
      chmodSync(dir, 0o755); // the container's unprivileged user must be able to read it
      chmodSync(file, 0o644);
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
          return { ok: false, error: "Docker is not available. Install Docker Desktop and start it to run code safely." };
        }
        return { ok: false, error: "Docker could not be started." };
      }
      // exit code 125 means docker itself failed (not the program)
      if (r.code === 125 && !r.timedOut) {
        if (/daemon|pipe|socket/i.test(r.stderr)) return { ok: false, error: "Docker is not running. Start Docker Desktop and try again." };
        return { ok: false, error: "Docker could not start the container. The first run of each language needs an internet connection to download its image." };
      }
      return { ok: true, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr), timedOut: r.timedOut };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
