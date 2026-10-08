import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OllamaProvider } from "./ollama";
import type { ProviderEvent, StreamRequest } from "./types";

let server: Server;
let url = "";
let delayMs = 0;

beforeEach(async () => {
  delayMs = 0;
  server = createServer((q, res) => {
    q.resume();
    // like a model on a slow CPU: nothing at all is sent until the whole prompt has been processed
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(JSON.stringify({ message: { content: "finally" }, done: true }) + "\n");
    }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const req = (): StreamRequest => ({ system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], signal: new AbortController().signal });
async function collect(p: OllamaProvider): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of p.stream(req())) out.push(e);
  return out;
}

describe("how long Ollama may take", () => {
  it("waits as long as the model needs by default: a slow CPU is not an error", async () => {
    delayMs = 600;
    const events = await collect(new OllamaProvider({ url, model: "m", contextTokens: 8192 }));
    expect(events.find((e) => e.type === "text_delta")).toMatchObject({ text: "finally" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("can be given a limit, and then reports a plain error when the model is too slow", async () => {
    delayMs = 3500; // undici checks its timers about once a second, so the limit is not exact
    const events = await collect(new OllamaProvider({ url, model: "m", contextTokens: 8192, timeoutMs: 500 }));
    const err = events.find((e) => e.type === "error") as Extract<ProviderEvent, { type: "error" }>;
    expect(err).toBeTruthy();
    expect(err.userFacing).toBe(true);
    expect(err.message).toMatch(/took too long|not answering/i);
  });

  it("the owner can still stop a turn that is waiting for the model", async () => {
    delayMs = 5000;
    const ac = new AbortController();
    const p = new OllamaProvider({ url, model: "m", contextTokens: 8192 });
    const started = Date.now();
    setTimeout(() => ac.abort(), 100);
    const out: ProviderEvent[] = [];
    for await (const e of p.stream({ ...req(), signal: ac.signal })) out.push(e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toEqual([]); // cancelled on purpose: no error shown
  });
});
