import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

/** Claude only accepts letters, digits, "_" and "-" in tool names, so "fs.list" travels as "fs__list". */
export const encodeToolName = (name: string): string => name.replaceAll(".", "__");
export const decodeToolName = (name: string): string => name.replaceAll("__", ".");

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeAnswer {
  text: string;
  isError?: boolean;
  images?: { mime: string; data: string }[];
}

/** A tool call from Claude, waiting for Friend to run it and answer. */
export interface BridgeCall {
  id: string;
  /** The real Friend tool name, such as "fs.list". */
  name: string;
  args: unknown;
  respond(answer: BridgeAnswer): void;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * A tiny MCP server for this PC only. It does not run tools: it hands each call that Claude makes to Friend, holds the
 * request open until Friend has run it (through the usual approvals) and answered, then returns that answer.
 */
export class ToolBridge {
  readonly token = randomBytes(24).toString("hex");
  private tools: BridgeTool[] = [];
  private http: HttpServer | null = null;
  private port = 0;
  private seq = 0;
  private pending = new Map<string, (a: BridgeAnswer) => void>();

  constructor(private onCall: (call: BridgeCall) => void) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  setTools(tools: BridgeTool[]): void {
    this.tools = tools;
  }

  async start(): Promise<void> {
    this.http = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.http!.listen(0, "127.0.0.1", resolve));
    this.port = (this.http.address() as { port: number }).port;
  }

  async stop(): Promise<void> {
    this.failPending("Friend is stopping.");
    const h = this.http;
    this.http = null;
    if (!h) return;
    h.closeAllConnections();
    await new Promise<void>((resolve) => h.close(() => resolve()));
  }

  /** Answers every call that is still waiting with an error, so Claude is never left hanging. */
  failPending(reason: string): void {
    for (const respond of [...this.pending.values()]) respond({ text: `Error: ${reason}`, isError: true });
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return false;
    const given = Buffer.from(header.slice(7));
    const wanted = Buffer.from(this.token);
    return given.length === wanted.length && timingSafeEqual(given, wanted);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "bad request" }));
      return;
    }
    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
    }
  }

  private buildServer(): Server {
    const server = new Server({ name: "friend", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.tools.map((t) => ({ name: encodeToolName(t.name), description: t.description, inputSchema: t.inputSchema as { type: "object" } })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const known = this.tools.find((t) => encodeToolName(t.name) === request.params.name);
      if (!known) return { isError: true, content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }] };
      const answer = await new Promise<BridgeAnswer>((resolve) => {
        const id = `cc-${++this.seq}`;
        let done = false;
        const respond = (a: BridgeAnswer) => {
          if (done) return;
          done = true;
          this.pending.delete(id);
          resolve(a);
        };
        this.pending.set(id, respond);
        this.onCall({ id, name: known.name, args: request.params.arguments ?? {}, respond });
      });
      return {
        ...(answer.isError ? { isError: true } : {}),
        content: [
          { type: "text" as const, text: answer.text },
          ...(answer.images ?? []).map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mime })),
        ],
      };
    });
    return server;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}
