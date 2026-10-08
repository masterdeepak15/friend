import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolBridge, decodeToolName, encodeToolName, type BridgeCall } from "./bridge";

const TOOLS = [
  { name: "fs.list", description: "List a folder.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "stage.show", description: "Show something.", inputSchema: { type: "object", properties: { object: { type: "object" } } } },
];

let bridge: ToolBridge;
let calls: BridgeCall[];
beforeEach(async () => {
  calls = [];
  bridge = new ToolBridge((c) => calls.push(c));
  bridge.setTools(TOOLS);
  await bridge.start();
});
afterEach(async () => {
  await bridge.stop();
});

async function client(token = bridge.token): Promise<Client> {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return c;
}
const post = (headers: Record<string, string> = {}, method = "POST") =>
  fetch(bridge.url, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) : undefined });
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("names", () => {
  it("turn dots into double underscores for Claude and back again", () => {
    expect(encodeToolName("fs.list")).toBe("fs__list");
    expect(encodeToolName("plugin.unit-converter.convert")).toBe("plugin__unit-converter__convert");
    expect(decodeToolName("stage__show")).toBe("stage.show");
    expect(decodeToolName(encodeToolName("plugin.unit-converter.convert"))).toBe("plugin.unit-converter.convert");
  });
  it("always fit what Claude accepts as a tool name", () => {
    for (const t of [...TOOLS, { name: "plugin.some-long-id.some-tool-name" }]) expect(encodeToolName(t.name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("who may talk to the bridge", () => {
  it("listens on this PC only", () => {
    expect(new URL(bridge.url).hostname).toBe("127.0.0.1");
    expect(bridge.token).toMatch(/^[0-9a-f]{32,}$/);
  });
  it("refuses a request without the token, with a wrong one, and any method but POST", async () => {
    expect((await post()).status).toBe(401);
    expect((await post({ authorization: "Bearer nope" })).status).toBe(401);
    expect((await post({ authorization: `Basic ${bridge.token}` })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${bridge.token}` }, "GET")).status).toBe(405);
    expect((await post({ authorization: `Bearer ${bridge.token}` }, "DELETE")).status).toBe(405);
    expect(calls).toEqual([]);
  });
  it("uses a different token for every bridge", async () => {
    const other = new ToolBridge(() => {});
    await other.start();
    expect(other.token).not.toBe(bridge.token);
    await other.stop();
  });
});

describe("listing tools", () => {
  it("offers exactly the tools it was given, with their descriptions and schemas", async () => {
    const c = await client();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["fs__list", "stage__show"]);
    expect(tools[0]).toMatchObject({ description: "List a folder.", inputSchema: { type: "object", required: ["path"] } });
    await c.close();
  });
  it("follows changes to the tool set", async () => {
    bridge.setTools([TOOLS[0]!]);
    const c = await client();
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["fs__list"]);
    await c.close();
  });
});

describe("calling tools", () => {
  it("hands the call to Friend with the real tool name, and returns what Friend answers", async () => {
    const c = await client();
    const pending = c.callTool({ name: "fs__list", arguments: { path: "C:/work" } });
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "fs.list", args: { path: "C:/work" } });
    calls[0]!.respond({ text: "a.txt\nb.txt" });
    expect(await pending).toMatchObject({ content: [{ type: "text", text: "a.txt\nb.txt" }] });
    await c.close();
  });

  it("holds the call open for as long as Friend needs, for example while the owner decides", async () => {
    const c = await client();
    let answered = false;
    const pending = c.callTool({ name: "fs__list", arguments: { path: "x" } }).then((r) => ((answered = true), r));
    await new Promise((r) => setTimeout(r, 400));
    expect(answered).toBe(false);
    calls[0]!.respond({ text: "late" });
    await pending;
    expect(answered).toBe(true);
    await c.close();
  });

  it("marks an error result as an error, and passes pictures along", async () => {
    const c = await client();
    const a = c.callTool({ name: "fs__list", arguments: { path: "x" } });
    await tick();
    calls[0]!.respond({ text: "Error: not allowed", isError: true });
    expect(await a).toMatchObject({ isError: true });
    const b = c.callTool({ name: "stage__show", arguments: {} });
    await tick();
    calls[1]!.respond({ text: "Picture taken.", images: [{ mime: "image/jpeg", data: "QUJD" }] });
    expect((await b).content).toEqual([
      { type: "text", text: "Picture taken." },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
    ]);
    await c.close();
  });

  it("gives every call its own id, and keeps parallel calls apart", async () => {
    const c = await client();
    const a = c.callTool({ name: "fs__list", arguments: { path: "a" } });
    const b = c.callTool({ name: "fs__list", arguments: { path: "b" } });
    await tick();
    expect(new Set(calls.map((x) => x.id)).size).toBe(2);
    const second = calls.find((x) => (x.args as { path: string }).path === "b")!;
    const first = calls.find((x) => (x.args as { path: string }).path === "a")!;
    second.respond({ text: "B" });
    first.respond({ text: "A" });
    expect((await a).content).toEqual([{ type: "text", text: "A" }]);
    expect((await b).content).toEqual([{ type: "text", text: "B" }]);
    await c.close();
  });

  it("answers a tool it does not know with an error instead of failing", async () => {
    const c = await client();
    const r = await c.callTool({ name: "rm__everything", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/unknown tool/i);
    expect(calls).toEqual([]);
    await c.close();
  });

  it("ignores a second answer to the same call", async () => {
    const c = await client();
    const p = c.callTool({ name: "fs__list", arguments: { path: "x" } });
    await tick();
    calls[0]!.respond({ text: "first" });
    calls[0]!.respond({ text: "second" });
    expect((await p).content).toEqual([{ type: "text", text: "first" }]);
    await c.close();
  });
});

describe("shutting down", () => {
  it("answers every call that is still waiting, so Claude is never left hanging", async () => {
    const c = await client();
    const p = c.callTool({ name: "fs__list", arguments: { path: "x" } });
    await tick();
    bridge.failPending("Friend is stopping.");
    const r = await p;
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("Friend is stopping.");
    await c.close();
  });
});
