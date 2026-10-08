import type { ToolResult } from "@friend/protocol";
import { statfsSync } from "node:fs";
import { arch, cpus, freemem, hostname, release, totalmem, uptime, userInfo } from "node:os";
import { runCommand, type ShellCtx } from "./shell";

/** How busy the processors were over a short sample, 0 to 100. */
async function cpuLoad(sampleMs: number): Promise<number | null> {
  const total = (list: ReturnType<typeof cpus>) =>
    list.reduce((acc, c) => {
      const t = c.times;
      const all = t.user + t.nice + t.sys + t.idle + t.irq;
      return { all: acc.all + all, idle: acc.idle + t.idle };
    }, { all: 0, idle: 0 });
  const a = total(cpus());
  await new Promise((r) => setTimeout(r, sampleMs));
  const b = total(cpus());
  const all = b.all - a.all;
  if (all <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((1 - (b.idle - a.idle) / all) * 100)));
}

function disk(): string | null {
  try {
    const root = process.platform === "win32" ? `${process.env.SystemDrive ?? "C:"}\\` : "/";
    const s = statfsSync(root);
    return `${((s.bavail * s.bsize) / 2 ** 30).toFixed(1)} GB free of ${((s.blocks * s.bsize) / 2 ** 30).toFixed(1)} GB (${root})`;
  } catch {
    return null; // not every system can report it
  }
}

export async function systemInfo(sampleMs = 250): Promise<ToolResult> {
  const load = await cpuLoad(sampleMs);
  const diskLine = disk();
  const lines = [
    `platform: ${process.platform} ${release()} (${arch()})`,
    `host: ${hostname()}`,
    `user: ${userInfo().username}`,
    `cpu: ${cpus()[0]?.model.trim() ?? "unknown"} x${cpus().length}`,
    ...(load === null ? [] : [`cpu load: ${load}%`]),
    `memory: ${(freemem() / 2 ** 30).toFixed(1)} GB free of ${(totalmem() / 2 ** 30).toFixed(1)} GB`,
    ...(diskLine ? [`disk: ${diskLine}`] : []),
    `uptime: ${(uptime() / 3600).toFixed(1)} hours`,
    `node: ${process.version}`,
  ];
  return { ok: true, output: lines.join("\n"), truncated: false };
}

export function processList(ctx: ShellCtx): Promise<ToolResult> {
  return process.platform === "win32"
    ? runCommand("", undefined, ctx, { file: "tasklist.exe", args: ["/fo", "csv", "/nh"] })
    : runCommand("", undefined, ctx, { file: "ps", args: ["-eo", "pid,comm"] });
}
