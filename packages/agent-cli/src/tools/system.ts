import type { ToolResult } from "@friend/protocol";
import { arch, cpus, freemem, hostname, release, totalmem, uptime, userInfo } from "node:os";
import { runCommand, type ShellCtx } from "./shell";

export function systemInfo(): ToolResult {
  const lines = [
    `platform: ${process.platform} ${release()} (${arch()})`,
    `host: ${hostname()}`,
    `user: ${userInfo().username}`,
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}`,
    `memory: ${(freemem() / 2 ** 30).toFixed(1)} GB free of ${(totalmem() / 2 ** 30).toFixed(1)} GB`,
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
