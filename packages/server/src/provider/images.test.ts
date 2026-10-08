import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHistory, saveMessage, stripImages } from "../agent/history";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { ClaudeProvider } from "./claude";
import { OllamaProvider } from "./ollama";
import type { Msg, StreamRequest } from "./types";

const PICTURE = "QUJDREVGRw=="; // base64 of "ABCDEFG"
const toolTurn: Msg[] = [
  { role: "user", content: [{ type: "text", text: "what is this?" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "camera.snap", input: {} }] },
  {
    role: "tool",
    content: [
      { type: "tool_result", toolUseId: "t1", content: "Picture taken.", isError: false },
      { type: "image", mime: "image/jpeg", data: PICTURE },
    ],
  },
];
const req = (messages: Msg[]): StreamRequest => ({ system: "s", messages, tools: [], signal: new AbortController().signal });

describe("Claude provider with pictures", () => {
  it("sends the picture right after the tool results in the same user message", async () => {
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
    const claude = new ClaudeProvider({ apiKey: "k", model: "m", client });
    expect(claude.vision).toBe(true);
    for await (const _ of claude.stream(req(toolTurn))) void _;
    const last = params.messages.at(-1);
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(last.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PICTURE } });
  });
});

describe("Ollama provider with pictures", () => {
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

  it("reports whether it can see from the config", () => {
    expect(new OllamaProvider({ url, model: "llava", contextTokens: 8192, vision: true }).vision).toBe(true);
    expect(new OllamaProvider({ url, model: "qwen2.5:7b", contextTokens: 8192 }).vision).toBe(false);
  });

  it("attaches the picture to a user message that follows the tool result", async () => {
    const p = new OllamaProvider({ url, model: "llava", contextTokens: 8192, vision: true });
    for await (const _ of p.stream(req(toolTurn))) void _;
    const msgs = bodies[0].messages;
    expect(msgs.at(-2)).toMatchObject({ role: "tool", content: "Picture taken." });
    expect(msgs.at(-1)).toMatchObject({ role: "user", images: [PICTURE] });
  });

  it("drops the picture when the model cannot see", async () => {
    const p = new OllamaProvider({ url, model: "qwen2.5:7b", contextTokens: 8192 });
    for await (const _ of p.stream(req(toolTurn))) void _;
    expect(JSON.stringify(bodies[0])).not.toContain(PICTURE);
  });
});

describe("pictures and history", () => {
  it("stripImages replaces each picture with the fixed text stub and leaves other blocks alone", () => {
    const stripped = stripImages(toolTurn[2]!);
    expect(stripped.content[0]).toEqual(toolTurn[2]!.content[0]);
    expect(stripped.content[1]).toEqual({ type: "text", text: "[camera picture, not kept]" });
    expect(JSON.stringify(stripped)).not.toContain(PICTURE);
  });

  it("never stores the picture: what is saved and loaded back has only the stub", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-img-")));
    for (const m of toolTurn) saveMessage(db, m);
    const raw = JSON.stringify(db.prepare("select content_json from messages").all());
    expect(raw).not.toContain(PICTURE);
    expect(JSON.stringify(loadHistory(db))).toContain("[camera picture, not kept]");
    db.close();
  });
});

describe("config", () => {
  it("has vision off by default for Ollama", () => {
    expect(loadConfig(mkdtempSync(join(tmpdir(), "friend-img-cfg-"))).ollama.vision).toBe(false);
  });
});
