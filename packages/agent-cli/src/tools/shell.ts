import type { ToolResult } from "@friend/protocol";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolveInRoots } from "./roots";

export interface ShellCtx {
  roots: string[];
  timeoutMs: number;
  maxOutput: number;
  allowOutside: boolean;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

export function runCommand(
  command: string,
  cwdArg: string | undefined,
  ctx: ShellCtx,
  argv?: { file: string; args: string[] },
): Promise<ToolResult> {
  let cwd = ctx.roots[0] ?? process.cwd();
  if (cwdArg) {
    const r = resolveInRoots(cwdArg, ctx.roots);
    if (!r.inside && !ctx.allowOutside) {
      return Promise.resolve({ ok: false, error: `Working directory is outside the allowed folders: ${cwdArg}` });
    }
    cwd = r.abs;
  }
  const win = process.platform === "win32";
  const file = argv?.file ?? (win ? "powershell.exe" : "sh");
  const args = argv?.args ?? (win ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command]);

  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, windowsHide: true, detached: !win, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let truncated = false;
    let timedOut = false;
    const take = (d: Buffer) => {
      if (out.length >= ctx.maxOutput) {
        truncated = true;
        return;
      }
      const s = d.toString("utf8");
      const room = ctx.maxOutput - out.length;
      if (s.length > room) {
        out += s.slice(0, room);
        truncated = true;
      } else out += s;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, ctx.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, error: `Command timed out after ${ctx.timeoutMs} ms` });
      const tail = code === 0 || code === null ? "" : `\n[exit code ${code}]`;
      resolve({ ok: true, output: out + tail, truncated });
    });
  });
}
