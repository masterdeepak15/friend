import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkerEvent, summarizeToolCall, type WorkerEvent } from "./events";

const raw = readFileSync(join(__dirname, "testdata", "session.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, any>);
const parsed: WorkerEvent[] = raw.flatMap((e) => parseWorkerEvent(e));
const of = <K extends WorkerEvent["kind"]>(kind: K) => parsed.filter((e): e is Extract<WorkerEvent, { kind: K }> => e.kind === kind);

describe("a recorded worker session", () => {
  it("starts with its session id and model, taken from the events", () => {
    const [init, ...rest] = of("init");
    expect(rest).toHaveLength(0);
    expect(init!.sessionId).toBe(raw[0]!.session_id);
    expect(init!.model).toBe(raw[0]!.model);
  });

  it("shows the two tool calls in plain words, without any file content", () => {
    expect(of("tool").map((t) => t.name)).toEqual(["Write", "Bash"]);
    expect(of("tool").map((t) => t.summary)).toEqual(["Write hello.txt", "Bash: npm install left-pad"]);
  });

  it("shows what each tool answered, and that the second was refused", () => {
    const r = of("tool_result");
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ ok: true });
    expect(r[1]).toMatchObject({ ok: false });
    expect(r[1]!.text).toMatch(/owner said no/i);
    expect(r[0]!.id).toBe(of("tool")[0]!.id);
  });

  it("reads how full the subscription windows are", () => {
    const q = of("quota");
    expect(q).toHaveLength(1);
    const w = q[0]!.quota.fiveHour!;
    expect(w.utilization).toBeGreaterThanOrEqual(0);
    expect(w.utilization).toBeLessThanOrEqual(1);
    expect(typeof w.resetsAt).toBe("number");
    expect(q[0]!.quota.sevenDay).not.toBeNull();
  });

  it("ends with a result: success, turns, time, tokens, the refused tool, the session", () => {
    const [res] = of("result");
    const src = raw.find((e) => e.type === "result")!;
    expect(res).toMatchObject({ ok: true, turns: 3, denials: ["Bash"], sessionId: src.session_id });
    expect(res!.durationMs).toBe(src.duration_ms);
    expect(res!.input).toBe(src.usage.input_tokens + (src.usage.cache_creation_input_tokens ?? 0));
    expect(res!.output).toBe(src.usage.output_tokens);
    expect(res!.text).toMatch(/hello\.txt/);
  });

  it("keeps what the worker said", () => {
    expect(of("text").at(-1)!.text).toMatch(/hello\.txt/);
  });

  it("never lets a line be longer than 4000 characters, and skips the partial stream", () => {
    for (const e of parsed) if ("text" in e) expect(e.text.length).toBeLessThanOrEqual(4000);
    expect(raw.some((e) => e.type === "stream_event")).toBe(true);
    expect(raw.filter((e) => e.type === "stream_event").flatMap((e) => parseWorkerEvent(e))).toEqual([]);
  });
});

describe("what is not an event", () => {
  it("gives nothing for junk, and nothing for an event it does not know", () => {
    expect(parseWorkerEvent("junk")).toEqual([]);
    expect(parseWorkerEvent(null)).toEqual([]);
    expect(parseWorkerEvent({})).toEqual([]);
    expect(parseWorkerEvent({ type: "something_new", data: 1 })).toEqual([]);
    expect(parseWorkerEvent({ type: "rate_limit_event", rate_limit_info: {} })).toEqual([]);
  });

  it("marks a failed result, and clips a very long answer", () => {
    const [r] = parseWorkerEvent({ type: "result", subtype: "error_during_execution", is_error: true, result: "x".repeat(9000), num_turns: 1, duration_ms: 5, usage: {}, session_id: "s" }) as Extract<WorkerEvent, { kind: "result" }>[];
    expect(r!.ok).toBe(false);
    expect(r!.text).toHaveLength(4000);
    expect(r!.denials).toEqual([]);
  });
});

describe("summarizeToolCall", () => {
  it("names a file tool by the file, never the content", () => {
    const s = summarizeToolCall("Write", { file_path: "C:\\proj\\a\\b.txt", content: "SECRET" });
    expect(s).toBe("Write b.txt");
    expect(s).not.toContain("SECRET");
    expect(summarizeToolCall("Edit", { file_path: "/home/x/src/app.ts", old_string: "SECRET", new_string: "S2" })).toBe("Edit app.ts");
  });

  it("shows the start of a shell command on one line", () => {
    expect(summarizeToolCall("Bash", { command: "npm test\nnpm run lint" })).toBe("Bash: npm test npm run lint");
    expect(summarizeToolCall("Bash", { command: "x".repeat(300) }).length).toBeLessThanOrEqual(80);
  });

  it("falls back to the tool name, and never throws on odd input", () => {
    expect(summarizeToolCall("WebSearch", { query: "secret thing" })).toBe("WebSearch");
    expect(summarizeToolCall("Write", null)).toBe("Write");
    expect(summarizeToolCall("Bash", { command: 5 })).toBe("Bash");
  });
});