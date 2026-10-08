import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeProvider } from "./claude";
import { OllamaProvider } from "./ollama";
import type { Msg, StreamRequest } from "./types";

const CONTEXT = "Context for this request:\nCurrent time: 2026-10-08T12:00:00+05:30";
const turn: Msg[] = [
  { role: "user", content: [{ type: "text", text: "what time is it?" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fs.list", input: { path: "C:/x" } }] },
  { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "a.txt", isError: false }] },
];
const req = (messages: Msg[], context?: string): StreamRequest => ({ system: "stable", messages, tools: [], signal: new AbortController().signal, ...(context ? { context } : {}) });

describe("Claude provider with a context", () => {
  async function sent(r: StreamRequest) {
    let params: any;
    const client = {
      messages: {
        create: async (p: unknown) => {
          params = p;
          return (async function* () {
            yield { type: "message_stop" };
          })();
        },
      },
    };
    for await (const _ of new ClaudeProvider({ apiKey: "k", model: "m", client }).stream(r)) void _;
    return params;
  }

  it("adds it as the last block of the last user message, after the tool results", async () => {
    const p = await sent(req(turn, CONTEXT));
    expect(p.system).toBe("stable"); // the system text is untouched
    const last = p.messages.at(-1);
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result" });
    expect(last.content.at(-1)).toEqual({ type: "text", text: CONTEXT });
    expect(p.messages).toHaveLength(3);
  });

  it("adds it to a plain user message too", async () => {
    const p = await sent(req([turn[0]!], CONTEXT));
    expect(p.messages.at(-1).content.at(-1)).toEqual({ type: "text", text: CONTEXT });
  });

  it("changes nothing without a context", async () => {
    const p = await sent(req(turn));
    expect(JSON.stringify(p.messages)).not.toContain("Context for this request");
  });
});

describe("Ollama provider with a context", () => {
  let server: Server;
  let url = "";
  let bodies: any[] = [];
  beforeEach(async () => {
    bodies = [];
    server = createServer((q, res) => {
      const parts: Buffer[] = [];
      q.on("data", (d) => parts.push(d));
      q.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(parts).toString()));
        res.writeHead(200, { "content-type": "application/x-ndjson" }).end(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const ask = async (r: StreamRequest, vision = false) => {
    for await (const _ of new OllamaProvider({ url, model: "m", contextTokens: 8192, vision }).stream(r)) void _;
    return bodies.at(-1).messages as { role: string; content: string; images?: string[] }[];
  };

  it("sends it as the very last message, so everything before it stays identical between calls", async () => {
    const a = await ask(req(turn, CONTEXT));
    const b = await ask(req(turn, CONTEXT.replace("12:00", "12:01")));
    expect(a.at(-1)).toEqual({ role: "user", content: CONTEXT });
    expect(JSON.stringify(a.slice(0, -1))).toBe(JSON.stringify(b.slice(0, -1)));
    expect(a[0]).toMatchObject({ role: "system", content: "stable" });
  });

  it("puts a camera picture before the context", async () => {
    const withPicture: Msg[] = [...turn.slice(0, 2), { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "ok", isError: false }, { type: "image", mime: "image/jpeg", data: "QUJD" }] }];
    const m = await ask(req(withPicture, CONTEXT), true);
    expect(m.at(-2)).toMatchObject({ role: "user", images: ["QUJD"] });
    expect(m.at(-1)).toEqual({ role: "user", content: CONTEXT });
  });

  it("sends no extra message without a context", async () => {
    const m = await ask(req(turn));
    expect(m.at(-1)).toMatchObject({ role: "tool" });
  });
});
