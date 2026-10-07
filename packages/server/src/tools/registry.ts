import { TOOL_DEFS, type ToolDef } from "@friend/protocol";
import { z } from "zod";
import { posix, win32 } from "node:path";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}

export function toolSpecs(): ToolSpec[] {
  return TOOL_DEFS.map((t) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

/** The path a tool call touches, if any (used for roots checks). */
export function pathArg(tool: string, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === "shell.run") return typeof a.cwd === "string" ? a.cwd : undefined;
  if (tool.startsWith("fs.")) return typeof a.path === "string" ? a.path : undefined;
  return undefined;
}

/** Purely lexical roots check (no filesystem access); the device re-checks with real paths. */
export function lexicalInsideRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  const isWinPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
  const win = isWinPath(path) || (!posix.isAbsolute(path) && isWinPath(roots[0]!));
  const lib = win ? win32 : posix;
  const fold = (s: string) => (win ? s.toLowerCase() : s);
  const absolute = lib.isAbsolute(path) ? path : lib.join(roots[0]!, path);
  const target = fold(lib.normalize(absolute));
  return roots.some((r) => {
    const root = fold(lib.normalize(r));
    const rel = lib.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !lib.isAbsolute(rel));
  });
}
