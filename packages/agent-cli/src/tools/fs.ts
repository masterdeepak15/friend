import type { ToolResult } from "@friend/protocol";
import { closeSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveInRoots } from "./roots";

export interface FsCtx {
  roots: string[];
  maxOutput: number;
  allowOutside: boolean;
}

const MAX_WRITE = 5 * 1024 * 1024;
const MAX_ENTRIES = 500;

function guard(p: string, ctx: FsCtx): { abs: string } | { error: string } {
  const r = resolveInRoots(p, ctx.roots);
  if (!r.inside && !ctx.allowOutside) return { error: `Path is outside the allowed folders: ${p}` };
  return { abs: r.abs };
}

export function fsList(args: { path: string }, ctx: FsCtx): ToolResult {
  const g = guard(args.path, ctx);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const entries = readdirSync(g.abs, { withFileTypes: true });
    const lines = entries.slice(0, MAX_ENTRIES).map((e) => {
      if (e.isDirectory()) return `[dir]  ${e.name}`;
      let size = 0;
      try {
        size = statSync(join(g.abs, e.name)).size;
      } catch {
        /* unreadable entry */
      }
      return `[file] ${e.name} (${size} bytes)`;
    });
    let output = lines.join("\n");
    let truncated = entries.length > MAX_ENTRIES;
    if (output.length > ctx.maxOutput) {
      output = output.slice(0, ctx.maxOutput);
      truncated = true;
    }
    return { ok: true, output, truncated };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function fsRead(args: { path: string }, ctx: FsCtx): ToolResult {
  const g = guard(args.path, ctx);
  if ("error" in g) return { ok: false, error: g.error };
  try {
    const st = statSync(g.abs);
    if (!st.isFile()) return { ok: false, error: "Not a file" };
    const want = Math.min(st.size, ctx.maxOutput);
    const buf = Buffer.alloc(want);
    const fd = openSync(g.abs, "r");
    try {
      readSync(fd, buf, 0, want, 0);
    } finally {
      closeSync(fd);
    }
    if (buf.subarray(0, Math.min(want, 8000)).includes(0)) return { ok: false, error: "File looks binary; not shown" };
    return { ok: true, output: buf.toString("utf8"), truncated: st.size > want };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function fsWrite(args: { path: string; content: string }, ctx: FsCtx): ToolResult {
  const g = guard(args.path, ctx);
  if ("error" in g) return { ok: false, error: g.error };
  if (Buffer.byteLength(args.content) > MAX_WRITE) return { ok: false, error: "Content too large (5 MB limit)" };
  try {
    mkdirSync(dirname(g.abs), { recursive: true });
    writeFileSync(g.abs, args.content);
    return { ok: true, output: `Wrote ${Buffer.byteLength(args.content)} bytes to ${g.abs}`, truncated: false };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
