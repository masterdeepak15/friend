import { TOOL_DEFS, type ToolResult } from "@friend/protocol";
import { fsList, fsRead, fsWrite } from "./fs";
import { runCommand } from "./shell";
import { processList, systemInfo } from "./system";

export interface ToolCtx {
  roots: string[];
  timeoutMs: number;
  maxOutput: number;
  allowOutside: boolean;
}

export const DEFAULT_CTX: Omit<ToolCtx, "roots"> = { timeoutMs: 60_000, maxOutput: 100_000, allowOutside: false };

export async function runTool(name: string, args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const def = TOOL_DEFS.find((t) => t.name === name && t.target === "device");
  if (!def) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: `Invalid arguments for ${name}: ${parsed.error.message}` };
  const a = parsed.data as never as Record<string, string>;
  try {
    switch (name) {
      case "fs.list":
        return fsList({ path: a.path! }, ctx);
      case "fs.read":
        return fsRead({ path: a.path! }, ctx);
      case "fs.write":
        return fsWrite({ path: a.path!, content: a.content! }, ctx);
      case "system.info":
        return systemInfo();
      case "process.list":
        return await processList(ctx);
      case "shell.run":
        return await runCommand(a.command!, a.cwd, ctx);
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export { resolveInRoots } from "./roots";
