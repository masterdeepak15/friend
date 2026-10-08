import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeCodeProvider } from "../provider/claude-code/provider";
import type { ProviderEvent, StreamRequest } from "../provider/types";
import { McpHub } from "./hub";
import { ConnectorStore } from "./store";

/** The real Claude Code, asked to use a connector's tool. Run with FRIEND_LIVE_CLAUDE=1. */
const live = process.env.FRIEND_LIVE_CLAUDE === "1" ? describe : describe.skip;
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-mcp.mjs");

live("a connector's tool through the real Claude Code", () => {
  it("is offered, called by name, and its answer is used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-live-conn-"));
    const hub = new McpHub(new ConnectorStore(dir));
    await hub.add({ id: "fake", name: "Fake", kind: "stdio", command: process.execPath, args: [FAKE] });
    const provider = new ClaudeCodeProvider({ dataDir: dir, model: "haiku" });
    const tools = hub.toolSpecs();
    const run = async (messages: StreamRequest["messages"]) => {
      const out: ProviderEvent[] = [];
      for await (const e of provider.stream({ system: "Be brief. Use tools when asked.", messages, tools, signal: new AbortController().signal, session: "owner" })) out.push(e);
      return out;
    };
    try {
      const msgs: StreamRequest["messages"] = [{ role: "user", content: [{ type: "text", text: "Use the echo tool of the Fake connector with the text 'ping-42' and tell me what it returned." }] }];
      const first = await run(msgs);
      const call = first.find((e) => e.type === "tool_call");
      expect(call).toMatchObject({ type: "tool_call", name: "mcp.fake.echo" });
      if (call?.type !== "tool_call") return;
      const result = await hub.call(call.name, call.args);
      expect(result.text).toBe("echo: ping-42");
      const next = await run([...msgs, { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.args }] }, { role: "tool", content: [{ type: "tool_result", toolUseId: call.id, content: result.text, isError: false }] }]);
      expect(next.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.text : "")).join("")).toContain("ping-42");
    } finally {
      await provider.close();
      await hub.close();
    }
  }, 120_000);
});
