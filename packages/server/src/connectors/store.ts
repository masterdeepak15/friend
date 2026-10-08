import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Letters, digits and single hyphens. Short, because the name travels inside every tool name the model sees. */
export const CONNECTOR_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_CONNECTORS = 20;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

const EnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HeaderName = /^[A-Za-z0-9-]+$/;

const Base = {
  id: z.string().min(1).max(16).regex(CONNECTOR_ID, "Use lowercase letters, digits and single hyphens (up to 16 characters)"),
  name: z.string().trim().min(1).max(60).refine(noControl, "No control characters"),
};

/** A program Friend starts and talks to over its standard input and output. Never run through a shell. */
const Stdio = z
  .object({
    ...Base,
    kind: z.literal("stdio"),
    command: z.string().trim().min(1).max(260).refine(noControl, "No control characters"),
    args: z.array(z.string().max(500).refine((s) => !s.includes("\u0000"), "No NUL characters")).max(20).default([]),
    env: z.record(z.string().regex(EnvName), z.string().max(2000).refine((s) => !s.includes("\u0000"))).refine((r) => Object.keys(r).length <= 20, "At most 20 variables").default({}),
  })
  .strict();

/** A server that is already running somewhere and speaks MCP over HTTP. */
const Http = z
  .object({
    ...Base,
    kind: z.literal("http"),
    url: z
      .string()
      .trim()
      .max(2000)
      .refine((u) => {
        try {
          const p = new URL(u);
          if (p.protocol === "https:") return true;
          return p.protocol === "http:" && LOOPBACK.has(p.hostname.toLowerCase());
        } catch {
          return false;
        }
      }, "Use https://, or http:// only for a server on this PC (localhost or 127.0.0.1)"),
    headers: z.record(z.string().regex(HeaderName), z.string().max(2000).refine(noControl)).refine((r) => Object.keys(r).length <= 10, "At most 10 headers").default({}),
  })
  .strict();

export const ConnectorInput = z.discriminatedUnion("kind", [Stdio, Http]);
export type ConnectorInput = z.infer<typeof ConnectorInput>;

export type ConnectorConfig = ConnectorInput & { enabled: boolean };

/** The saved list of connectors. The file can hold secrets (tokens in a header or variable), so only this user can read it. */
export class ConnectorStore {
  private path: string;
  private items: ConnectorConfig[];

  constructor(dataDir: string) {
    this.path = join(dataDir, "connectors.json");
    this.items = this.load();
  }

  private load(): ConnectorConfig[] {
    if (!existsSync(this.path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return []; // a damaged file is treated as empty rather than stopping Friend
    }
    if (!Array.isArray(raw)) return [];
    const out: ConnectorConfig[] = [];
    for (const r of raw) {
      const { enabled: on, ...rest } = (r && typeof r === "object" ? r : {}) as { enabled?: unknown };
      const enabled = !!on;
      const parsed = ConnectorInput.safeParse(rest);
      if (parsed.success && !out.some((o) => o.id === parsed.data.id)) out.push({ ...parsed.data, enabled });
    }
    return out.slice(0, MAX_CONNECTORS);
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* permission bits unsupported on this OS */
    }
    renameSync(tmp, this.path);
  }

  list(): ConnectorConfig[] {
    return this.items.map((i) => ({ ...i }));
  }

  get(id: string): ConnectorConfig | undefined {
    const i = this.items.find((x) => x.id === id);
    return i ? { ...i } : undefined;
  }

  add(cfg: ConnectorConfig): { ok: true } | { ok: false; error: string } {
    if (this.items.some((i) => i.id === cfg.id)) return { ok: false, error: `There is already a connector called "${cfg.id}".` };
    if (this.items.length >= MAX_CONNECTORS) return { ok: false, error: `At most ${MAX_CONNECTORS} connectors. Remove one first.` };
    this.items.push({ ...cfg });
    this.save();
    return { ok: true };
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const i = this.items.find((x) => x.id === id);
    if (!i) return false;
    i.enabled = enabled;
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const n = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === n) return false;
    this.save();
    return true;
  }
}

/** What may be shown on screen: where it connects, never a secret. */
export function describeTarget(c: ConnectorConfig): string {
  if (c.kind === "stdio") return [c.command, ...c.args].join(" ").slice(0, 200);
  try {
    const u = new URL(c.url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(invalid address)";
  }
}

export const hasSecrets = (c: ConnectorConfig): boolean => (c.kind === "stdio" ? Object.keys(c.env).length > 0 : Object.keys(c.headers).length > 0 || new URL(c.url).search !== "");
