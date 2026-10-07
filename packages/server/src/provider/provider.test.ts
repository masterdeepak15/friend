import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "./claude";
import { FakeProvider } from "./fake";
import type { ProviderEvent } from "./types";

async function collect(it: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}
const req = (signal = new AbortController().signal) => ({ system: "s", messages: [], tools: [], signal });

describe("FakeProvider", () => {
  it("replays one script entry per stream call, in order", async () => {
    const p = new FakeProvider([
      [{ type: "text_delta", text: "a" }, { type: "done" }],
      [{ type: "text_delta", text: "b" }, { type: "done" }],
    ]);
    expect(await collect(p.stream(req()))).toEqual([{ type: "text_delta", text: "a" }, { type: "done" }]);
    expect(await collect(p.stream(req()))).toEqual([{ type: "text_delta", text: "b" }, { type: "done" }]);
    expect(p.calls).toHaveLength(2);
  });
  it("reports an error event when the script is exhausted", async () => {
    const events = await collect(new FakeProvider([]).stream(req()));
    expect(events[0]?.type).toBe("error");
  });
});

const sdkEvents = [
  { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "fs__list", input: {} } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"C:/x"}' } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
  { type: "message_stop" },
];

function fakeClient(events: unknown[], onParams?: (p: unknown) => void, throwAt?: Error) {
  return {
    messages: {
      create: async (params: unknown, _opts: unknown) => {
        onParams?.(params);
        if (throwAt) throw throwAt;
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    },
  };
}

describe("ClaudeProvider", () => {
  it("maps SDK stream events to text deltas, a tool call with decoded name, usage and done", async () => {
    let sent: any;
    const p = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient(sdkEvents, (x) => (sent = x)) as never });
    const events = await collect(
      p.stream({ ...req(), tools: [{ name: "fs.list", description: "d", inputSchema: { type: "object" } }] }),
    );
    expect(events.filter((e) => e.type === "text_delta").map((e: any) => e.text).join("")).toBe("Hello");
    expect(events.find((e) => e.type === "tool_call")).toEqual({ type: "tool_call", id: "tu1", name: "fs.list", args: { path: "C:/x" } });
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", input: 5, output: 12 });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(sent.tools[0].name).toBe("fs__list");
    expect(sent.model).toBe("m");
    expect(sent.stream).toBe(true);
  });
  it("converts tool results into user tool_result blocks", async () => {
    let sent: any;
    const p = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([{ type: "message_stop" }], (x) => (sent = x)) as never });
    await collect(
      p.stream({
        ...req(),
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fs.list", input: { path: "." } }] },
          { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "a.txt", isError: false }] },
        ],
      }),
    );
    expect(sent.messages[1].content[0].name).toBe("fs__list");
    expect(sent.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt", is_error: false }] });
  });
  it("turns an SDK error into one error event and ends", async () => {
    const p = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient([], undefined, new Error("boom")) as never });
    const events = await collect(p.stream(req()));
    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });
  it("stops iterating when the signal is aborted", async () => {
    const ac = new AbortController();
    const many = Array.from({ length: 50 }, () => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }));
    const p = new ClaudeProvider({ apiKey: "k", model: "m", client: fakeClient(many) as never });
    const out: ProviderEvent[] = [];
    for await (const e of p.stream({ ...req(ac.signal) })) {
      out.push(e);
      if (out.length === 3) ac.abort();
    }
    expect(out.length).toBeLessThan(10);
  });
  it("throws a helpful message when the API key is missing", () => {
    expect(() => new ClaudeProvider({ apiKey: "", model: "m" })).toThrow(/friend config set/);
  });
});
