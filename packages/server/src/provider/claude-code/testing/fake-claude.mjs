#!/usr/bin/env node
/**
 * A stand-in for the `claude` command, for tests. It speaks the same stream-json format on stdin/stdout, plays back a
 * script instead of calling a model, and makes real MCP calls to the tool bridge named in --mcp-config. It records
 * what it was started with and what it was sent, so tests can check both.
 *
 * Environment:
 *   FAKE_CLAUDE_SCRIPT  path to JSON: { "turns": [ [step, ...], ... ] }  (one entry per user message, across restarts)
 *   FAKE_CLAUDE_STATE   path to a JSON file that keeps the turn counter and the known session ids between processes
 *   FAKE_CLAUDE_LOG     path to a file that gets one JSON line per start / user message / tool result
 *
 * Steps: { text, delay? } | { calls: [{ tool, args }], text? } | { limit: "message", exit?: true } | { die: code }
 *        | { hang: true } | { error: "message" } (a result with is_error) | { sleep: ms }
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const log = (o) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ pid: process.pid, ...o }) + "\n");
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const statePath = process.env.FAKE_CLAUDE_STATE;
const readState = () => (statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { turn: 0, sessions: [], nextSession: 1 });
const writeState = (s) => statePath && writeFileSync(statePath, JSON.stringify(s));

log({ start: true, argv, cwd: process.cwd(), env: { MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT } });

const script = process.env.FAKE_CLAUDE_SCRIPT ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCRIPT, "utf8")) : { turns: [] };

let state = readState();
const resume = flag("--resume");
if (resume && !state.sessions.includes(resume)) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}
const sessionId = resume ?? `fake-session-${state.nextSession++}`;
if (!state.sessions.includes(sessionId)) state.sessions.push(sessionId);
writeState(state);

let mcp = null;
async function bridge() {
  if (mcp) return mcp;
  const cfgPath = flag("--mcp-config");
  if (!cfgPath) throw new Error("no --mcp-config: there is no bridge to call");
  const server = Object.values(JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers)[0];
  const client = new Client({ name: "fake-claude", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  return (mcp = client);
}

async function playTurn(steps, turn) {
  emit({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model") });
  let finalText = "";
  let n = 0;
  for (const step of steps) {
    if (step.sleep) await sleep(step.sleep);
    if (step.text !== undefined && !step.calls) {
      for (const w of step.text.match(/\S+\s*/g) ?? []) {
        emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } });
        if (step.delay) await sleep(step.delay);
      }
      emit({ type: "assistant", message: { content: [{ type: "text", text: step.text }] } });
      finalText = step.text;
    }
    if (step.calls) {
      const blocks = [];
      if (step.text) {
        for (const w of step.text.match(/\S+\s*/g) ?? []) emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: w } } });
        blocks.push({ type: "text", text: step.text });
      }
      step.calls.forEach((c, i) => blocks.push({ type: "tool_use", id: `toolu_${turn}_${n + i}`, name: `mcp__friend__${c.tool}`, input: c.args ?? {} }));
      emit({ type: "assistant", message: { content: blocks } });
      const client = await bridge();
      // the real Claude Code runs a message's tool calls one after the other (step.serial), so the second call only
      // reaches the bridge once the first has been answered
      const results = step.serial
        ? await step.calls.reduce(async (acc, c) => [...(await acc), await client.callTool({ name: c.tool, arguments: c.args ?? {} })], Promise.resolve([]))
        : await Promise.all(step.calls.map((c) => client.callTool({ name: c.tool, arguments: c.args ?? {} })));
      log({ mcpResults: results.map((r) => ({ isError: r.isError ?? false, content: r.content })) });
      emit({ type: "user", message: { content: results.map((r, i) => ({ type: "tool_result", tool_use_id: `toolu_${turn}_${n + i}`, content: r.content, is_error: r.isError ?? false })) } });
      n += step.calls.length;
    }
    if (step.limit) {
      emit({ type: "assistant", message: { content: [{ type: "text", text: step.limit }] } });
      emit({ type: "result", subtype: "success", is_error: true, result: step.limit, session_id: sessionId, usage: { input_tokens: 0, output_tokens: 0 } });
      if (step.exit) process.exit(1);
      return;
    }
    if (step.error) {
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: step.error, session_id: sessionId, usage: { input_tokens: 0, output_tokens: 0 } });
      return;
    }
    if (step.die !== undefined) process.exit(step.die);
    if (step.hang) await new Promise(() => {});
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: finalText,
    session_id: sessionId,
    duration_api_ms: 5,
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7, iterations: [{ input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 5, output_tokens: 3 }, { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5, output_tokens: 4 }] },
  });
}

const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type !== "user") return;
  log({ user: msg.message.content });
  chain = chain.then(async () => {
    // the counter moves on before the turn is played, so a turn that crashes or is killed is not replayed
    state = readState();
    const index = state.turn++;
    writeState(state);
    await playTurn(script.turns[index] ?? [{ text: "(the script has ended)" }], index);
  });
});
rl.on("close", () => chain.then(() => process.exit(0)));
