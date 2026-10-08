import { describe, expect, it, vi } from "vitest";
import { FallbackProvider } from "./fallback";
import type { Provider, ProviderEvent, StreamRequest } from "./types";

const req = (over: Partial<StreamRequest> = {}): StreamRequest => ({
  system: "s",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  signal: new AbortController().signal,
  ...over,
});
const collect = async (it: AsyncIterable<ProviderEvent>) => {
  const out: ProviderEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
};

function stub(id: string, script: ProviderEvent[][], extra: Partial<Provider> = {}) {
  const calls: StreamRequest[] = [];
  let i = 0;
  const p: Provider = {
    id,
    async *stream(r: StreamRequest) {
      calls.push(r);
      for (const e of script[i++] ?? [{ type: "done" as const }]) yield e;
    },
    ...extra,
  };
  return { p, calls };
}
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const err = (message: string): ProviderEvent => ({ type: "error", userFacing: true, message });

describe("FallbackProvider", () => {
  it("passes everything through while the main provider works, and never touches the other", async () => {
    const a = stub("a", [[text("Hi"), done]]);
    const b = stub("b", [[text("never"), done]]);
    const onFallback = vi.fn();
    const f = new FallbackProvider(a.p, b.p, onFallback);
    expect(await collect(f.stream(req()))).toEqual([text("Hi"), done]);
    expect(b.calls).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("uses the other provider, and says why, when the main one fails before it says anything", async () => {
    const a = stub("a", [[err("Your Claude plan limit is reached.")]]);
    const b = stub("b", [[text("From the local model."), done]]);
    const onFallback = vi.fn();
    const events = await collect(new FallbackProvider(a.p, b.p, onFallback).stream(req()));
    expect(events).toEqual([text("From the local model."), done]);
    expect(onFallback).toHaveBeenCalledWith("Your Claude plan limit is reached.");
    expect(b.calls).toHaveLength(1);
    expect(b.calls[0]).toMatchObject({ system: "s" }); // the same request, unchanged
  });

  it("does not hide a failure that happens after the main provider has already started answering", async () => {
    const a = stub("a", [[text("Part of an answer "), err("Claude Code stopped unexpectedly.")]]);
    const b = stub("b", [[text("never"), done]]);
    const events = await collect(new FallbackProvider(a.p, b.p, () => {}).stream(req()));
    expect(events).toEqual([text("Part of an answer "), err("Claude Code stopped unexpectedly.")]);
    expect(b.calls).toHaveLength(0);
  });

  it("sends an answer to a tool call back to whichever provider made the call", async () => {
    const a = stub("a", [[{ type: "tool_call", id: "cc-1", name: "fs.list", args: {} }, done], [text("Claude's answer"), done]]);
    const b = stub("b", [[text("Ollama's answer"), done]]); // only ever asked for the answer: its own call is made up below
    const f = new FallbackProvider(a.p, b.p, () => {});
    await collect(f.stream(req()));
    const afterClaude = req({ messages: [...req().messages, { role: "assistant", content: [{ type: "tool_use", id: "cc-1", name: "fs.list", input: {} }] }, { role: "tool", content: [{ type: "tool_result", toolUseId: "cc-1", content: "x", isError: false }] }] });
    expect(await collect(f.stream(afterClaude))).toEqual([text("Claude's answer"), done]);
    const afterOllama = req({ messages: [...req().messages, { role: "assistant", content: [{ type: "tool_use", id: "ollama-9", name: "fs.list", input: {} }] }, { role: "tool", content: [{ type: "tool_result", toolUseId: "ollama-9", content: "x", isError: false }] }] });
    expect(await collect(f.stream(afterOllama))).toEqual([text("Ollama's answer"), done]);
  });

  it("does not repeat the same notice over and over", async () => {
    const a = stub("a", [[err("limit")], [err("limit")], [err("limit")]]);
    const b = stub("b", [[done], [done], [done]]);
    const onFallback = vi.fn();
    let now = 0;
    const f = new FallbackProvider(a.p, b.p, onFallback, () => now);
    for (let i = 0; i < 3; i++) await collect(f.stream(req()));
    expect(onFallback).toHaveBeenCalledTimes(1);
    now += 11 * 60_000; // later, a new failure is worth telling the owner about again
    const a2 = stub("a2", [[err("limit again")]]);
    const f2 = new FallbackProvider(a2.p, b.p, onFallback, () => now);
    await collect(f2.stream(req()));
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback).toHaveBeenLastCalledWith("limit again");
  });

  it("reports the main provider's picture ability, and closes both", async () => {
    const closeA = vi.fn(async () => {});
    const closeB = vi.fn(async () => {});
    const f = new FallbackProvider(stub("a", [], { vision: true, close: closeA }).p, stub("b", [], { close: closeB }).p, () => {});
    expect(f.vision).toBe(true);
    expect(f.id).toBe("a+b");
    await f.close();
    expect(closeA).toHaveBeenCalled();
    expect(closeB).toHaveBeenCalled();
  });

  it("falls back for a guest request too, with the request's session marker intact", async () => {
    const a = stub("a", [[err("not signed in")]]);
    const b = stub("b", [[text("ok"), done]]);
    await collect(new FallbackProvider(a.p, b.p, () => {}).stream(req({ session: "guest" })));
    expect(b.calls[0]!.session).toBe("guest");
  });
});
