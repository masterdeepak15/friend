import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import crossSpawn from "cross-spawn";
import { createHash } from "node:crypto";
import { ConnectorInput, ConnectorStore, describeTarget, hasSecrets, type ConnectorConfig } from "./store";

export type ConnectorStatus = "off" | "connecting" | "ready" | "error";

/** What the screen and the AI may see about a connector. Never a secret. */
export interface ConnectorView {
  id: string;
  name: string;
  kind: "stdio" | "http";
  enabled: boolean;
  status: ConnectorStatus;
  error: string | null;
  tools: number;
  /** The program and its arguments, or the address without its query. */
  target: string;
  /** A token or key is stored for it (shown as "secret saved", never the value). */
  secret: boolean;
}

export interface McpToolSpec {
  /** mcp.<connector>.<tool>, the name the model uses. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Tool {
  full: string;
  original: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface Live {
  client: Client;
  /** The way to the program (its process id, when it is a program), to stop it for certain. */
  transport?: { pid?: number | null };
  status: ConnectorStatus;
  error: string | null;
  tools: Tool[];
  /** Last lines the program wrote to its error output, to explain a failure. */
  stderr: string;
  connecting?: Promise<void>;
}

const MAX_RESULT_BYTES = 1024 * 1024;
/** mcp__friend__ + mcp__<id>__<tool> must stay under the 64 characters Claude allows in a tool name. */
const MAX_TOOL_PART = 28;

/** A tool name the model can use: letters, digits, single "_" and "-", short, and never ending up the same as another. */
export function friendlyToolName(original: string, taken: Set<string>): string {
  let n = original.replace(/[^A-Za-z0-9_-]/g, "-").replace(/_{2,}/g, "_").replace(/^[-_]+/, "") || "tool";
  if (n.length > MAX_TOOL_PART) n = `${n.slice(0, MAX_TOOL_PART - 7)}_${createHash("sha1").update(original).digest("hex").slice(0, 5)}`;
  let out = n;
  for (let i = 2; taken.has(out); i++) out = `${n.slice(0, MAX_TOOL_PART - 3)}_${i}`;
  taken.add(out);
  return out;
}

/** Ends a program and everything it started. A program started through npx or a .cmd file has helpers that a plain stop leaves running. */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") crossSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    else process.kill(pid, "SIGKILL");
  } catch {
    /* it was already gone */
  }
}

/** Closes a connection without ever waiting on a program that will not stop. */
async function stopLive(l: Live): Promise<void> {
  const pid = l.transport?.pid ?? null;
  await Promise.race([l.client.close().catch(() => {}), new Promise<void>((r) => setTimeout(r, 3000).unref?.())]);
  if (pid) killTree(pid);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 400);
const sleepReject = (ms: number, what: string): Promise<never> =>
  new Promise((_, rej) => {
    const t = setTimeout(() => rej(new Error(what)), ms);
    t.unref?.();
  });

export interface HubOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Extra environment for started programs (tests). */
  baseEnv?: Record<string, string>;
}

/**
 * Keeps the owner's MCP connectors connected and offers their tools to the agent as mcp.<connector>.<tool>.
 * It never decides what may run: every call goes through the agent's usual approvals first.
 */
export class McpHub {
  private live = new Map<string, Live>();
  private names = new Map<string, { id: string; original: string }>();

  constructor(
    private store: ConnectorStore,
    private opts: HubOptions = {},
  ) {}

  // ---- what is known ----

  list(): ConnectorView[] {
    return this.store.list().map((c) => this.view(c));
  }

  private view(c: ConnectorConfig): ConnectorView {
    const l = this.live.get(c.id);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      enabled: c.enabled,
      status: !c.enabled ? "off" : (l?.status ?? "connecting"),
      error: c.enabled ? (l?.error ?? null) : null,
      tools: c.enabled && l?.status === "ready" ? l.tools.length : 0,
      target: describeTarget(c),
      secret: hasSecrets(c),
    };
  }

  /** The tools of every connected connector, for the model. */
  toolSpecs(): McpToolSpec[] {
    const out: McpToolSpec[] = [];
    for (const c of this.store.list()) {
      const l = this.live.get(c.id);
      if (!c.enabled || l?.status !== "ready") continue;
      for (const t of l.tools) out.push({ name: t.full, description: `[${c.name}] ${t.description}`.slice(0, 1000), inputSchema: t.inputSchema });
    }
    return out;
  }

  has(fullName: string): boolean {
    return this.names.has(fullName);
  }

  /** One line for the model's context: which connectors exist and whether they work. */
  summary(): string {
    const items = this.list();
    if (items.length === 0) return "none";
    return items.map((c) => `${c.id} (${c.name}: ${c.status === "ready" ? `ready, ${c.tools} tools` : c.status === "error" ? `not working: ${c.error ?? "unknown"}` : c.status})`).join("; ");
  }

  // ---- changing the list ----

  /** Saves a new connector and, unless told otherwise, connects it. Resolves once it is connected or has failed. */
  async add(raw: unknown, opts: { enable?: boolean } = {}): Promise<ConnectorView> {
    const parsed = ConnectorInput.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(i ? `${i.path.join(".") || "connector"}: ${i.message}` : "Invalid connector");
    }
    const cfg: ConnectorConfig = { ...parsed.data, enabled: opts.enable !== false };
    const saved = this.store.add(cfg);
    if (!saved.ok) throw new Error(saved.error);
    if (cfg.enabled) await this.tryConnect(cfg.id);
    return this.view(this.store.get(cfg.id)!);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ConnectorView> {
    if (!this.store.setEnabled(id, enabled)) throw new Error(`There is no connector "${id}".`);
    if (enabled) await this.tryConnect(id);
    else await this.disconnect(id);
    return this.view(this.store.get(id)!);
  }

  /** Connects again and reads the tool list again (after the program was updated, or a failure). */
  async reload(id: string): Promise<ConnectorView> {
    const c = this.store.get(id);
    if (!c) throw new Error(`There is no connector "${id}".`);
    await this.disconnect(id);
    if (c.enabled) await this.tryConnect(id);
    return this.view(this.store.get(id)!);
  }

  async remove(id: string): Promise<void> {
    if (!this.store.remove(id)) throw new Error(`There is no connector "${id}".`);
    await this.disconnect(id);
  }

  /** Connects every switched-on connector without making Friend wait for any of them. */
  startAll(): void {
    for (const c of this.store.list()) if (c.enabled) void this.connect(c.id).catch(() => {});
  }

  async close(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }

  // ---- calling ----

  async call(fullName: string, args: unknown, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const target = this.names.get(fullName);
    if (!target) return { text: `Unknown connector tool: ${fullName}`, isError: true };
    let l = this.live.get(target.id);
    if (!l || l.status !== "ready") {
      // one try to bring it back before giving up
      try {
        await this.connect(target.id);
      } catch (e) {
        return { text: `The connector "${target.id}" is not available: ${messageOf(e)}`, isError: true };
      }
      l = this.live.get(target.id);
      if (!l || l.status !== "ready") return { text: `The connector "${target.id}" is not available.`, isError: true };
    }
    try {
      const res = (await l.client.callTool(
        { name: target.original, arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {} },
        undefined,
        { signal, timeout: this.opts.callTimeoutMs ?? 120_000, resetTimeoutOnProgress: true },
      )) as { content?: unknown[]; isError?: boolean };
      return { text: flatten(res.content), isError: !!res.isError };
    } catch (e) {
      if (signal?.aborted) return { text: "Cancelled.", isError: true };
      return { text: `The connector "${target.id}" failed: ${messageOf(e)}${l.stderr ? `\n${l.stderr}` : ""}`, isError: true };
    }
  }

  // ---- connecting ----

  /** Connects, leaving a failure in the connector's status (what the screen and the AI are shown) instead of throwing. */
  private async tryConnect(id: string): Promise<void> {
    try {
      await this.connect(id);
    } catch {
      /* the reason is in the status */
    }
  }

  private async connect(id: string): Promise<void> {
    const cfg = this.store.get(id);
    if (!cfg) throw new Error(`There is no connector "${id}".`);
    const existing = this.live.get(id);
    if (existing?.status === "ready") return;
    if (existing?.connecting) return existing.connecting;
    await this.disconnect(id);

    const client = new Client({ name: "friend", version: "1.0.0" });
    const entry: Live = { client, status: "connecting", error: null, tools: [], stderr: "" };
    this.live.set(id, entry);
    entry.connecting = (async () => {
      try {
        const transport = this.transportFor(cfg, entry);
        entry.transport = transport as { pid?: number | null };
        client.onclose = () => {
          if (this.live.get(id) === entry && entry.status === "ready") {
            entry.status = "error";
            entry.error = "The connection closed."; // the tool names stay known, so the next call can start it again
          }
        };
        await Promise.race([client.connect(transport), sleepReject(this.opts.connectTimeoutMs ?? 60_000, "It did not answer in time.")]);
        await this.readTools(id, entry);
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          try {
            await this.readTools(id, entry);
          } catch {
            /* keep the tools we had */
          }
        });
        entry.status = "ready";
        entry.error = null;
      } catch (e) {
        entry.status = "error";
        entry.error = `${messageOf(e)}${entry.stderr ? ` (${entry.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 200)})` : ""}`;
        await stopLive(entry);
        throw new Error(entry.error);
      } finally {
        entry.connecting = undefined;
      }
    })();
    return entry.connecting;
  }

  private transportFor(cfg: ConnectorConfig, entry: Live) {
    if (cfg.kind === "stdio") {
      const t = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...this.opts.baseEnv, ...cfg.env },
        stderr: "pipe",
      });
      t.stderr?.on("data", (d: Buffer) => {
        entry.stderr = (entry.stderr + d.toString("utf8")).slice(-2000);
      });
      return t;
    }
    return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } });
  }

  private async readTools(id: string, entry: Live): Promise<void> {
    const found: { name: string; description?: string; inputSchema?: Record<string, unknown> }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await entry.client.listTools(cursor ? { cursor } : undefined);
      found.push(...(r.tools as typeof found));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    this.forget(id);
    const taken = new Set<string>();
    entry.tools = found.slice(0, 100).map((t) => {
      const friendly = friendlyToolName(t.name, taken);
      const full = `mcp.${id}.${friendly}`;
      this.names.set(full, { id, original: t.name });
      return { full, original: t.name, description: (t.description ?? t.name).slice(0, 900), inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} } };
    });
  }

  /** Takes a connector's tools out of the name list. */
  private forget(id: string): void {
    for (const [name, t] of this.names) if (t.id === id) this.names.delete(name);
  }

  private async disconnect(id: string): Promise<void> {
    const l = this.live.get(id);
    this.live.delete(id);
    this.forget(id);
    if (!l) return;
    l.client.onclose = undefined;
    await stopLive(l);
  }
}

/** The text of a tool result. Pictures and other binary parts are named, not carried. */
function flatten(content: unknown[] | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return "(no output)";
  const parts: string[] = [];
  for (const b of content as { type?: string; text?: unknown; mimeType?: string; data?: string; resource?: { text?: string; uri?: string } }[]) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b.type === "image") parts.push(`[a picture (${b.mimeType ?? "image"}) was returned and is not shown to you]`);
    else if (b.type === "resource" && b.resource) parts.push(typeof b.resource.text === "string" ? b.resource.text : `[resource ${b.resource.uri ?? ""}]`);
    else parts.push(`[${b.type ?? "unknown"} content]`);
  }
  const text = parts.join("\n");
  return text.length > MAX_RESULT_BYTES ? `${text.slice(0, MAX_RESULT_BYTES)}\n[output truncated]` : text;
}
