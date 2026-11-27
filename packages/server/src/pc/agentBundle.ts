import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

export interface AgentBundle {
  js: Buffer;
  sha256: string;
}

/**
 * The agent file the PCs download (one bundled JavaScript file made by `pnpm --filter @friend/pc-agent bundle`). It is looked for in the
 * given places, the first that exists wins, and it is read again when the file changes (so a new build is picked up without a restart).
 */
export class AgentFile {
  private cached: { path: string; mtime: number; bundle: AgentBundle } | null = null;
  constructor(private readonly paths: (string | undefined)[]) {}

  get(): AgentBundle | null {
    for (const p of this.paths) {
      if (!p || !existsSync(p)) continue;
      const mtime = statSync(p).mtimeMs;
      if (this.cached && this.cached.path === p && this.cached.mtime === mtime) return this.cached.bundle;
      const js = readFileSync(p);
      this.cached = { path: p, mtime, bundle: { js, sha256: createHash("sha256").update(js).digest("hex") } };
      return this.cached.bundle;
    }
    return null;
  }
}
