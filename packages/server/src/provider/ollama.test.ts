import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OllamaProvider } from "./ollama";
import type { Msg, ProviderEvent, StreamRequest } from "./types";

let server: Server;
let url = "";
let bodies: any[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

const ndjson = (res: ServerResponse, lines: unknown[]) => {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const l of lines) res.write(JSON.stringify(l) + "\n");
  res.end();
};

beforeEach(async () => {
  bodies = [];
  respond = (_req, res) => ndjson(res, [{ message: { role: "assistant", content: "ok" }, done: true }]);
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(parts).toString() || "{}"));
      } catch {
        bodies.push(null);
      }
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const provider = (extra: object = {}) => new OllamaProvider({ url, model: "qwen2.5:7b", contextTokens: 8192, ...extra });
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({ system: "be helpful", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], signal: new AbortController().signal, ...over });
async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("OllamaProvider streaming", () => {
  it("streams text deltas, reports usage and finishes with done", async () => {
    respond = (_q, res) =>
      ndjson(res, [
        { message: { role: "assistant", content: "Hel" }, done: false },
        { message: { role: "assistant", content: "lo" }, done: false },
        { message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 11, eval_count: 7 },
      ]);
    const events = await collect(provider().stream(req()));
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("Hello");
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", input: 11, output: 7 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("turns a tool call into a tool_call event with a generated id and the decoded tool name", async () => {
    respond = (_q, res) =>
      ndjson(res, [
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "fs__list", arguments: { path: "C:/x" } } }] }, done: false },
        { message: { role: "assistant", content: "" }, done: true },
      ]);
    const events = await collect(provider().stream(req()));
    const call = events.find((e) => e.type === "tool_call") as Extract<ProviderEvent, { type: "tool_call" }>;
    expect(call.name).toBe("fs.list");
    expect(call.args).toEqual({ path: "C:/x" });
    expect(call.id).toMatch(/^ollama-/);
  });

  it("accepts tool arguments sent as a JSON string and survives broken ones", async () => {
    respond = (_q, res) =>
      ndjson(res, [
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "fs__read", arguments: '{"path":"a.txt"}' } }] }, done: false },
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "fs__list", arguments: "{not json" } }] }, done: false },
        { message: { role: "assistant", content: "" }, done: true },
      ]);
    const calls = (await collect(provider().stream(req()))).filter((e) => e.type === "tool_call") as any[];
    expect(calls[0].args).toEqual({ path: "a.txt" });
    expect(calls[1].args).toEqual({}); // the agent loop reports invalid arguments back to the model
  });

  it("gives every tool call its own id", async () => {
    respond = (_q, res) =>
      ndjson(res, [
        { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "fs__list", arguments: {} } }, { function: { name: "system__info", arguments: {} } }] }, done: false },
        { message: { role: "assistant", content: "" }, done: true },
      ]);
    const calls = (await collect(provider().stream(req()))).filter((e) => e.type === "tool_call") as any[];
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  });

  it("handles a response split across network chunks", async () => {
    respond = (_q, res) => {
      res.writeHead(200);
      const line = JSON.stringify({ message: { role: "assistant", content: "split" }, done: false }) + "\n";
      res.write(line.slice(0, 10));
      setTimeout(() => {
        res.write(line.slice(10));
        res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
      }, 20);
    };
    const events = await collect(provider().stream(req()));
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("split");
  });
});

describe("OllamaProvider request", () => {
  it("posts to /api/chat with the model, streaming, context size and keep-alive", async () => {
    await collect(provider().stream(req()));
    expect(bodies[0]).toMatchObject({ model: "qwen2.5:7b", stream: true, options: { num_ctx: 8192 }, keep_alive: "30m" });
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(bodies[0].messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("describes tools in the function format with dot-free names", async () => {
    await collect(provider().stream(req({ tools: [{ name: "fs.list", description: "List a folder", inputSchema: { type: "object", properties: { path: { type: "string" } } } }] })));
    expect(bodies[0].tools).toEqual([
      { type: "function", function: { name: "fs__list", description: "List a folder", parameters: { type: "object", properties: { path: { type: "string" } } } } },
    ]);
  });

  it("sends no tools field when there are none", async () => {
    await collect(provider().stream(req()));
    expect(bodies[0].tools).toBeUndefined();
  });

  it("maps assistant tool calls and tool results back, linking results to tool names", async () => {
    const messages: Msg[] = [
      { role: "user", content: [{ type: "text", text: "list" }] },
      { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "fs.list", input: { path: "." } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "a.txt", isError: false }] },
    ];
    await collect(provider().stream(req({ messages })));
    const sent = bodies[0].messages;
    expect(sent[2]).toEqual({ role: "assistant", content: "Looking.", tool_calls: [{ function: { name: "fs__list", arguments: { path: "." } } }] });
    expect(sent[3]).toEqual({ role: "tool", content: "a.txt", tool_name: "fs__list" });
  });

  it("marks tool errors in the content so the model can react", async () => {
    const messages: Msg[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "shell.run", input: { command: "x" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "Error: denied", isError: true }] },
    ];
    await collect(provider().stream(req({ messages })));
    expect(bodies[0].messages.at(-1).content).toContain("Error: denied");
  });

  it("sends several results from one step as separate tool messages", async () => {
    const messages: Msg[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "fs.list", input: {} }, { type: "tool_use", id: "b", name: "system.info", input: {} }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "a", content: "one", isError: false }, { type: "tool_result", toolUseId: "b", content: "two", isError: false }] },
    ];
    await collect(provider().stream(req({ messages })));
    const tools = bodies[0].messages.filter((m: any) => m.role === "tool");
    expect(tools.map((t: any) => [t.tool_name, t.content])).toEqual([["fs__list", "one"], ["system__info", "two"]]);
  });
});

describe("OllamaProvider errors", () => {
  it("explains an unreachable server in plain words", async () => {
    const events = await collect(new OllamaProvider({ url: "http://127.0.0.1:1", model: "m", contextTokens: 4096 }).stream(req()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", userFacing: true });
    expect((events[0] as any).message).toMatch(/can't reach ollama/i);
    expect((events[0] as any).message).toContain("http://127.0.0.1:1");
  });

  it("explains a missing model and how to get it", async () => {
    respond = (_q, res) => {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "model 'qwen2.5:7b' not found" }));
    };
    const events = await collect(provider().stream(req()));
    expect(events[0]).toMatchObject({ type: "error", userFacing: true });
    expect((events[0] as any).message).toMatch(/qwen2\.5:7b/);
    expect((events[0] as any).message).toMatch(/friend ollama setup/);
  });

  it("reports a model that does not support tools", async () => {
    respond = (_q, res) => {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: '"llama2" does not support tools' }));
    };
    const events = await collect(provider().stream(req({ tools: [{ name: "x", description: "d", inputSchema: {} }] })));
    expect(events[0]).toMatchObject({ type: "error", userFacing: true });
    expect((events[0] as any).message).toMatch(/does not support tools/i);
  });

  it("turns other failures into a short error event", async () => {
    respond = (_q, res) => {
      res.writeHead(500).end("boom");
    };
    const events = await collect(provider().stream(req()));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
  });

  it("reports an error line inside a 200 stream", async () => {
    respond = (_q, res) => ndjson(res, [{ error: "out of memory" }]);
    const events = await collect(provider().stream(req()));
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("stops quietly when the request is aborted", async () => {
    respond = (_q, res) => {
      res.writeHead(200);
      res.write(JSON.stringify({ message: { content: "a" }, done: false }) + "\n");
      // never finishes
    };
    const ac = new AbortController();
    const out: ProviderEvent[] = [];
    for await (const e of provider().stream(req({ signal: ac.signal }))) {
      out.push(e);
      ac.abort();
    }
    expect(out.some((e) => e.type === "error")).toBe(false);
  });
});
