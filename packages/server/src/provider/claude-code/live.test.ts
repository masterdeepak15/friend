import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderEvent, StreamRequest } from "../types";
import { ClaudeCodeProvider } from "./provider";

/** Talks to the real `claude` CLI and uses the signed-in subscription. Run with FRIEND_LIVE_CLAUDE=1. */
const live = process.env.FRIEND_LIVE_CLAUDE === "1" ? describe : describe.skip;

const req = (text: string, over: Partial<StreamRequest> = {}): StreamRequest => ({
  system: "You are Friend, a brief assistant. Answer in one short sentence.",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  tools: [],
  signal: new AbortController().signal,
  session: "owner",
  ...over,
});
const collect = async (it: AsyncIterable<ProviderEvent>) => {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

live("the real Claude Code CLI", () => {
  it("answers, then calls a Friend tool and continues with its result", async () => {
    const p = new ClaudeCodeProvider({ dataDir: mkdtempSync(join(tmpdir(), "friend-live-")), model: "haiku" });
    try {
      const t0 = Date.now();
      const a = await collect(p.stream(req("Say the word pong.")));
      console.log("first answer ms", Date.now() - t0, JSON.stringify(a.filter((e) => e.type !== "text_delta")));
      expect(a.some((e) => e.type === "error")).toBe(false);
      expect(a.map((e) => (e.type === "text_delta" ? e.text : "")).join("").toLowerCase()).toContain("pong");

      const tools = [{ name: "weather.get", description: "Get the current weather for a city.", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }];
      const messages1: StreamRequest["messages"] = [{ role: "user", content: [{ type: "text", text: "What is the weather in Paris? Use the tool." }] }];
      const t1 = Date.now();
      const b = await collect(p.stream(req("", { messages: messages1, tools })));
      const call = b.find((e) => e.type === "tool_call");
      console.log("tool call ms", Date.now() - t1, JSON.stringify(b.filter((e) => e.type !== "text_delta")));
      expect(call).toBeTruthy();
      if (call?.type !== "tool_call") return;
      expect(call.name).toBe("weather.get");

      const messages2: StreamRequest["messages"] = [
        ...messages1,
        { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: call.args }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: call.id, content: "Paris: 18 C, clear sky", isError: false }] },
      ];
      const c = await collect(p.stream(req("", { messages: messages2, tools })));
      const text = c.map((e) => (e.type === "text_delta" ? e.text : "")).join("");
      console.log("final", text);
      expect(text).toMatch(/18/);
    } finally {
      await p.close();
    }
  }, 120_000);
});
