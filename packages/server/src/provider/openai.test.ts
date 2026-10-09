import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenAiProvider, toOpenAiMessages } from "./openai";
import type { Msg, ProviderEvent, StreamRequest } from "./types";

let server: Server;
let url = "";
let bodies: any[] = [];
let headers: IncomingMessage["headers"][] = [];
let paths: string[] = [];
let respond: (req: IncomingMessage, res: ServerResponse) => void;

const sse = (res: ServerResponse, chunks: unknown[], done = true) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (done) res.write("data: [DONE]\n\n");
  res.end();
};
const delta = (d: object, extra: object = {}) => ({ choices: [{ index: 0, delta: d, ...extra }] });

beforeEach(async () => {
  bodies = [];
  headers = [];
  paths = [];
  respond = (_q, res) => sse(res, [delta({ content: "ok" })]);
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      paths.push(req.url ?? "");
      headers.push(req.headers);
      try {
        bodies.push(JSON.parse(Buffer.concat(parts).toString() || "{}"));
      } catch {
        bodies.push(null);
      }
      respond(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const provider = (extra: object = {}) => new OpenAiProvider({ url, model: "auto", ...extra });
const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({ system: "be helpful", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], signal: new AbortController().signal, ...over });
async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("OpenAiProvider (OmniRoute and other OpenAI-compatible servers)", () => {
  it("streams text, reports usage and finishes with done", async () => {
    respond = (_q, res) => sse(res, [delta({ content: "Hel" }), delta({ content: "lo" }), delta({}, { finish_reason: "stop" }), { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }]);
    const events = await collect(provider().stream(req()));
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("Hello");
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", input: 11, output: 7 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("posts to {url}/chat/completions with the model, streaming on, and the API key as a Bearer token", async () => {
    await collect(provider({ apiKey: "sk-test", url: `${url}/` }).stream(req()));
    expect(paths).toEqual(["/v1/chat/completions"]);
    expect(headers[0]!.authorization).toBe("Bearer sk-test");
    expect(bodies[0]).toMatchObject({ model: "auto", stream: true });
    expect(bodies[0].messages[0]).toEqual({ role: "system", content: "be helpful" });
  });

  it("sends no Authorization header when there is no key", async () => {
    await collect(provider().stream(req()));
    expect(headers[0]!.authorization).toBeUndefined();
  });

  it("sends the tools with dot-free names and the changing context last", async () => {
    await collect(provider().stream(req({ context: "It is noon.", tools: [{ name: "fs.list", description: "list", inputSchema: { type: "object", properties: {} } }] })));
    expect(bodies[0].tools[0]).toEqual({ type: "function", function: { name: "fs__list", description: "list", parameters: { type: "object", properties: {} } } });
    expect(bodies[0].messages.at(-1)).toEqual({ role: "user", content: "It is noon." });
  });

  it("joins a tool call that arrives in pieces and gives it its real name back", async () => {
    respond = (_q, res) =>
      sse(res, [
        delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "fs__li", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { name: "st", arguments: '{"path"' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: ':"C:/x"}' } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_2", function: { name: "clock__now", arguments: "{}" } }] }),
        delta({}, { finish_reason: "tool_calls" }),
      ]);
    const calls = (await collect(provider().stream(req()))).filter((e) => e.type === "tool_call");
    expect(calls).toEqual([
      { type: "tool_call", id: "call_1", name: "fs.list", args: { path: "C:/x" } },
      { type: "tool_call", id: "call_2", name: "clock.now", args: {} },
    ]);
  });

  it("turns unreadable tool arguments into empty ones instead of failing", async () => {
    respond = (_q, res) => sse(res, [delta({ tool_calls: [{ index: 0, id: "c", function: { name: "a", arguments: "{oops" } }] })]);
    const call = (await collect(provider().stream(req()))).find((e) => e.type === "tool_call") as any;
    expect(call.args).toEqual({});
  });

  it("finishes properly when the stream just ends without [DONE]", async () => {
    respond = (_q, res) => sse(res, [delta({ content: "hi" })], false);
    const events = await collect(provider().stream(req()));
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("explains a refused key, a missing model and a rate limit in plain words", async () => {
    const fail = (status: number, message: string) => {
      respond = (_q, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
      };
    };
    fail(401, "bad key");
    expect(await collect(provider().stream(req()))).toEqual([{ type: "error", userFacing: true, message: "The model server refused the API key. Check it in Settings." }]);
    fail(404, "no such model");
    expect(((await collect(provider().stream(req())))[0] as any).message).toMatch(/no "auto".*\/v1.*no such model/s);
    fail(429, "slow down");
    expect(((await collect(provider().stream(req())))[0] as any).message).toMatch(/too many requests/);
    fail(500, "boom");
    expect(await collect(provider().stream(req()))).toEqual([{ type: "error", message: "Model server error (500): boom" }]);
  });

  it("says so when the server cannot be reached", async () => {
    const events = await collect(new OpenAiProvider({ url: "http://127.0.0.1:1/v1", model: "auto" }).stream(req()));
    expect(events).toHaveLength(1);
    expect((events[0] as any).message).toMatch(/can't reach the model server.*Settings/);
  });

  it("reports an error that arrives inside the stream", async () => {
    respond = (_q, res) => sse(res, [{ error: { message: "quota used up" } }], false);
    const events = await collect(provider().stream(req()));
    expect(events).toEqual([{ type: "error", message: "Model server error: quota used up" }]);
  });
});

describe("messages in the OpenAI shape", () => {
  const history: Msg[] = [
    { role: "user", content: [{ type: "text", text: "list my files" }] },
    { role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "fs.list", input: { path: "C:/" } }] },
    { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "a.txt", isError: false }] },
  ];

  it("keeps a tool call's id so its result can be matched, and encodes the name and arguments", () => {
    const m = toOpenAiMessages("sys", history, false);
    expect(m[2]).toEqual({ role: "assistant", content: "Looking.", tool_calls: [{ id: "t1", type: "function", function: { name: "fs__list", arguments: '{"path":"C:/"}' } }] });
    expect(m[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "a.txt" });
  });

  it("sends a camera picture only to a model that can see", () => {
    const pic: Msg[] = [{ role: "tool", content: [{ type: "image", mime: "image/jpeg", data: "QUJD" }] }];
    expect(toOpenAiMessages("s", pic, false)).toHaveLength(1);
    const withPic = toOpenAiMessages("s", pic, true);
    expect(withPic).toHaveLength(2);
    expect(JSON.stringify(withPic[1])).toContain("data:image/jpeg;base64,QUJD");
  });
});
