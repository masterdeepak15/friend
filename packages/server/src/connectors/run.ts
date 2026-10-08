import crossSpawn from "cross-spawn";
import type { QuickRunner } from "./quick";

const LIMIT_MS = 5 * 60_000;

/**
 * Runs a fixed command to completion, streaming what it prints. Used only for the one-click installs, whose commands are
 * written in Friend's own code and never contain anything the person typed. Stopped after five minutes.
 */
export const runCommand: QuickRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = "";
    let child: ReturnType<typeof crossSpawn>;
    try {
      child = crossSpawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: 127, stdout: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill(), LIMIT_MS);
    const feed = (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts?.onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLine(line);
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: stdout + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
  });
