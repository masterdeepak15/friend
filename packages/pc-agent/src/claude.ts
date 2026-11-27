import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeSession {
  id: string;
  summary: string;
  /** When the session was last used (milliseconds). */
  at: number;
}

/** Claude Code keeps a project's sessions in a folder named after the project path with everything but letters and digits turned into a dash. */
export const projectFolder = (project: string): string => project.replace(/[^A-Za-z0-9]/g, "-");

/** The words the person typed in a message: the first piece that is not one of Claude Code's own tags (`<command-name>...`). */
function textOf(content: unknown): string {
  const parts: string[] = typeof content === "string" ? [content] : Array.isArray(content) ? content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")) : [];
  return parts.map((p) => p.trim()).find((p) => p && !p.startsWith("<")) ?? "";
}

/** The earlier Claude Code sessions of a project, newest first, each with its id and a line saying what it was about. */
export async function claudeSessions(project: string, home = homedir(), limit = 15): Promise<ClaudeSession[]> {
  const dir = join(home, ".claude", "projects", projectFolder(project));
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const found: ClaudeSession[] = [];
  for (const n of names) {
    const file = join(dir, n);
    const st = await fs.stat(file).catch(() => null);
    if (!st) continue;
    let summary = "";
    try {
      const handle = await fs.open(file, "r");
      try {
        const buf = Buffer.alloc(Math.min(st.size, 96 * 1024));
        await handle.read(buf, 0, buf.length, 0);
        let fallback = "";
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          let j: Record<string, unknown>;
          try {
            j = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue; // the last line of the slice may be cut
          }
          if (j.type === "summary" && typeof j.summary === "string") {
            summary = j.summary;
            break;
          }
          if (!fallback && j.type === "user") {
            const t = textOf((j.message as { content?: unknown } | undefined)?.content);
            if (t) fallback = t;
          }
        }
        if (!summary) summary = fallback;
      } finally {
        await handle.close();
      }
    } catch {
      /* unreadable: listed without a summary */
    }
    found.push({ id: n.replace(/\.jsonl$/, ""), summary: summary.replace(/\s+/g, " ").slice(0, 140), at: st.mtimeMs });
  }
  return found.sort((a, b) => b.at - a.at).slice(0, limit);
}
