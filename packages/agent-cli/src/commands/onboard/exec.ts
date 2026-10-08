import crossSpawn from "cross-spawn";
import type { Runner } from "../voice";

/** Runs a command to completion with its output shown to the person (installers, sign-in pages). Resolves with the exit code. */
export type Interactive = (cmd: string, args: string[]) => Promise<number>;

const CHECK_TIMEOUT_MS = 20_000;

/**
 * Runs a command and captures what it prints. Unlike a plain spawn this finds programs that are really scripts on Windows
 * (npm, claude), and a program that hangs is stopped after twenty seconds instead of freezing the wizard.
 */
export const capture: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(cmd, args, { cwd: opts?.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout: (e as Error).message });
      return;
    }
    // a quick check that hangs is stopped; a long job that streams its output (a download, an install) may take as long as it needs
    const timer = opts?.onLine ? null : setTimeout(() => child.kill(), CHECK_TIMEOUT_MS);
    const feed = (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts?.onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLine(line);
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout: stdout + e.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
  });

export const interactive: Interactive = (cmd, args) =>
  new Promise((resolve) => {
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(cmd, args, { stdio: "inherit" });
    } catch {
      resolve(127);
      return;
    }
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
