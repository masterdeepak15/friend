import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Msg, Provider, ProviderEvent, StreamRequest, ToolSpec } from "../types";
import { ToolBridge, encodeToolName, type BridgeCall } from "./bridge";
import { isUsageLimit, usageLimitBackoffMs } from "./limits";
import { ClaudeProc, type ProcItem } from "./process";

export interface ClaudeCodeOptions {
  /** The Friend data folder. Claude Code runs in `<dataDir>/claude`, an empty folder of its own. */
  dataDir: string;
  /** A model alias or name for `claude --model`. */
  model?: string;
  /** The command to run. Defaults to `claude`. */
  command?: string;
  /** Lets the owner's Claude search the web with its own WebSearch tool (a guest never gets it). Off unless asked for. */
  webSearch?: boolean;
  /** Arguments that come before Claude's own (tests run a fake script this way). */
  commandArgs?: string[];
  env?: Record<string, string>;
  /** Longest silence while Claude is thinking before it is declared stuck. */
  idleTimeoutMs?: number;
  /** Longest wait for a freshly started Claude to show any sign of life (it has to start up first). */
  startupTimeoutMs?: number;
  /** How long a tool call may stay open, for example while the owner decides on an approval card. */
  toolTimeoutMs?: number;
  now?: () => number;
}

type Item = ProcItem | { kind: "call"; call: BridgeCall };

/** A queue the process and the bridge both write into, and the running request reads from. */
class Inbox {
  private items: Item[] = [];
  private waiter: ((i: Item) => void) | null = null;

  push(item: Item): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(item);
    } else this.items.push(item);
  }

  clear(): void {
    this.items = [];
  }

  next(timeoutMs: number | undefined, signal: AbortSignal | undefined): Promise<Item | "timeout" | "abort"> {
    if (signal?.aborted) return Promise.resolve("abort");
    const first = this.items.shift();
    if (first) return Promise.resolve(first);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (v: Item | "timeout" | "abort") => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiter = null;
        resolve(v);
      };
      const onAbort = () => finish("abort");
      this.waiter = (i) => finish(i);
      if (timeoutMs !== undefined) timer = setTimeout(() => finish("timeout"), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** One Claude Code conversation: a process, what it was started with, and the tool calls waiting for Friend. */
interface Conv {
  guest: boolean;
  proc: ClaudeProc | null;
  inbox: Inbox;
  sessionId: string | null;
  systemKey: string;
  toolsKey: string;
  /** Tool calls handed to Friend that Claude is still waiting for. */
  awaiting: BridgeCall[];
  /** Whether the process already knows the conversation (it was resumed, or has been told it all). */
  hasContext: boolean;
  startedWithResume: boolean;
  gotEvent: boolean;
  draining: Promise<void> | null;
}

const MORE_CALLS_MS = 1500; // at most this long after the first call, for calls Claude announced but that have not arrived
const GRACE_MS = 250; // after the expected tool calls have arrived: wait a moment for any more in the same step
const DRAIN_MS = 15_000;

const newConv = (guest: boolean): Conv => ({
  guest, proc: null, inbox: new Inbox(), sessionId: null, systemKey: "", toolsKey: "", awaiting: [],
  hasContext: false, startedWithResume: false, gotEvent: false, draining: null,
});

const toolsKeyOf = (tools: ToolSpec[]) => createHash("sha1").update(JSON.stringify(tools)).digest("hex");

/** An assistant message Claude itself wrote (not one Friend made up around data it gathered, which uses "auto-" ids). */
const writtenByClaude = (m: Msg): boolean => m.role === "assistant" && m.content.every((b) => b.type !== "tool_use" || b.id.startsWith("cc-"));

const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|authentication[_ ]error|oauth token|sign in/i;

/**
 * Claude Code as a model, through your own Claude subscription. To the rest of Friend it is just another provider:
 * one long-lived `claude` process answers every message (so the start-up cost is paid once), and Friend's tools are
 * offered to it through a bridge on this PC. A tool call is not run by the bridge: it is handed to Friend's usual
 * agent loop as an ordinary tool call, with all its approvals, and the answer is passed back into the waiting call.
 */
export class ClaudeCodeProvider implements Provider {
  readonly id = "claude-code";
  readonly vision = true;
  private owner = newConv(false);
  /** Set when the owner's conversation was reset and the new one has not begun yet: what it starts from (a summary, or nothing). */
  private fresh: { seed: string | null } | null = null;
  private guests = new Set<ClaudeProc>();
  private bridge: ToolBridge;
  private bridgeReady: Promise<void> | null = null;
  private limitedUntil = 0;
  private readonly home: string;
  private readonly now: () => number;

  constructor(private opts: ClaudeCodeOptions) {
    this.home = join(opts.dataDir, "claude");
    this.now = opts.now ?? Date.now;
    this.bridge = new ToolBridge((call) => this.owner.inbox.push({ kind: "call", call }));
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
    if (this.limitedUntil > this.now()) {
      yield this.limitError(this.lastLimitText);
      return;
    }
    const guest = req.session === "guest";
    const conv = guest ? newConv(true) : this.owner;
    if (conv.draining) await conv.draining;

    let finished = false;
    let collected: BridgeCall[] = [];
    try {
      const continuing = !guest && conv.awaiting.length > 0 && this.answerPending(conv, req.messages);
      if (!continuing && conv.awaiting.length > 0) await this.cancelPending(conv);

      for (let attempt = 0; ; attempt++) {
        if (!continuing) {
          try {
            await this.ensureProcess(conv, req);
          } catch (e) {
            yield { type: "error", userFacing: true, message: (e as Error).message };
            finished = true;
            return;
          }
          conv.proc!.send(this.userContent(req, conv));
          conv.hasContext = true;
        }
        collected = [];
        const outcome = yield* this.readStep(conv, req, collected);
        if (outcome === "resume-failed" && attempt === 0 && !continuing) continue; // start over without the lost session
        finished = true;
        return;
      }
    } finally {
      if (!finished) this.abandonStep(conv, collected); // the consumer stopped early: do not leave Claude waiting
      if (guest) this.endGuest(conv);
    }
  }

  /** Forgets the owner's conversation. The next message starts a new Claude with `seed` (if any) instead of the old story. */
  async resetSession(seed?: string): Promise<void> {
    const conv = this.owner;
    const proc = conv.proc;
    conv.proc = null; // anything the old process still says is ignored
    proc?.kill();
    await proc?.exited;
    conv.inbox.clear();
    conv.awaiting = [];
    conv.hasContext = false;
    conv.systemKey = "";
    this.forgetSession(conv);
    mkdirSync(this.home, { recursive: true });
    this.fresh = { seed: seed?.trim() || null };
    try {
      writeFileSync(this.freshFile(), JSON.stringify(this.fresh));
    } catch {
      /* the next start is still fresh, it only forgets the summary if Friend restarts first */
    }
  }

  async close(): Promise<void> {
    this.bridge.failPending("Friend is stopping.");
    this.owner.proc?.kill();
    for (const p of this.guests) p.kill();
    await Promise.all([this.owner.proc?.exited, ...[...this.guests].map((p) => p.exited)]);
    this.guests.clear();
    await this.bridge.stop();
  }

  // ---- a step: what Claude does between two calls to stream() ----

  private async *readStep(conv: Conv, req: StreamRequest, collected: BridgeCall[]): AsyncGenerator<ProviderEvent, "ok" | "resume-failed"> {
    const idle = this.opts.idleTimeoutMs ?? 120_000;
    const startup = Math.max(idle, this.opts.startupTimeoutMs ?? 30_000);
    let expected = 0;
    let turnText = "";
    let firstCallAt = 0;
    for (;;) {
      const haveCalls = collected.length > 0 && (expected === 0 || collected.length >= expected);
      // Claude Code runs a message's tool calls one after the other, so a second call may only arrive once the first
      // has been answered: never wait long for calls that are announced but not here yet, hand over what has arrived.
      const wait = haveCalls
        ? GRACE_MS
        : collected.length > 0
          ? Math.max(GRACE_MS, MORE_CALLS_MS - (this.now() - firstCallAt))
          : conv.gotEvent ? idle : startup;
      // a Claude that has not made a sound yet is still starting up, which takes a while
      const item = await conv.inbox.next(wait, req.signal);

      if (item === "abort") {
        this.abandonStep(conv, collected);
        return "ok";
      }
      if (item === "timeout") {
        if (collected.length > 0) return yield* this.flushCalls(conv, collected);
        conv.proc?.kill();
        conv.proc = null;
        yield { type: "error", userFacing: true, message: "Claude Code did not answer in time. Try again." };
        return "ok";
      }
      if (item.kind === "call") {
        if (collected.length === 0) firstCallAt = this.now();
        collected.push(item.call);
        continue;
      }
      if (item.kind === "exit") return yield* this.onExit(conv, item, turnText);

      const ev = item.ev;
      conv.gotEvent = true;
      if (typeof ev.session_id === "string") this.rememberSession(conv, ev.session_id);
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
        const t = String(ev.event.delta.text ?? "");
        if (t) yield { type: "text_delta", text: t };
      } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b?.type === "text") turnText += String(b.text ?? "");
          else if (b?.type === "tool_use") expected++;
        }
      } else if (ev.type === "result") {
        return yield* this.onResult(conv, ev, turnText);
      }
    }
  }

  private async *flushCalls(conv: Conv, collected: BridgeCall[]): AsyncGenerator<ProviderEvent, "ok"> {
    conv.awaiting = [...collected];
    for (const c of collected) yield { type: "tool_call", id: c.id, name: c.name, args: c.args };
    yield { type: "done" };
    return "ok";
  }

  private async *onResult(conv: Conv, ev: Record<string, any>, turnText: string): AsyncGenerator<ProviderEvent, "ok"> {
    const text = String(ev.result ?? turnText);
    if (!ev.is_error) {
      const u = ev.usage ?? {};
      const sum = (x: Record<string, any>) => (x.input_tokens ?? 0) + (x.cache_read_input_tokens ?? 0) + (x.cache_creation_input_tokens ?? 0);
      const last = Array.isArray(u.iterations) ? u.iterations.at(-1) : undefined; // the last call to the model read the whole conversation once
      yield { type: "usage", input: sum(u), output: u.output_tokens ?? 0, ...(last ? { context: sum(last) } : {}) };
      yield { type: "done" };
      return "ok";
    }
    yield this.errorFor(text);
    return "ok";
  }

  private async *onExit(conv: Conv, item: Extract<ProcItem, { kind: "exit" }>, turnText: string): AsyncGenerator<ProviderEvent, "ok" | "resume-failed"> {
    conv.proc = null;
    if (item.notInstalled) {
      yield { type: "error", userFacing: true, message: "Claude Code is not installed (or not on the PATH). Install it, sign in once, then run: friend claude setup" };
      return "ok";
    }
    if (conv.startedWithResume && !conv.gotEvent && /no conversation found/i.test(item.stderr)) {
      this.forgetSession(conv); // Claude no longer has that conversation
      return "resume-failed";
    }
    const said = `${turnText}\n${item.stderr}`;
    if (isUsageLimit(said)) yield this.errorFor(said);
    else yield { type: "error", userFacing: true, message: "Claude Code stopped unexpectedly. Try again." };
    return "ok";
  }

  private errorFor(text: string): ProviderEvent {
    if (isUsageLimit(text)) {
      const wait = usageLimitBackoffMs(text, new Date(this.now()))!;
      this.limitedUntil = this.now() + wait;
      this.lastLimitText = text;
      return this.limitError(text);
    }
    if (NOT_SIGNED_IN.test(text)) return { type: "error", userFacing: true, message: "Claude Code is not signed in. Sign in once, then run: friend claude setup" };
    return { type: "error", userFacing: true, message: `Claude Code reported an error: ${text.slice(0, 300)}` };
  }

  private lastLimitText = "";
  private limitError(text: string): ProviderEvent {
    const reset = /resets?\s+\d{1,2}:\d{2}\s*[ap]m(?:\s*\([^)]+\))?/i.exec(text)?.[0];
    return { type: "error", userFacing: true, message: `Your Claude plan limit is reached${reset ? ` (${reset})` : ""}. I will not ask Claude again until then.` };
  }

  // ---- tool calls waiting for Friend ----

  /** The request is the answer to the calls Claude is waiting for: pass the results on. */
  private answerPending(conv: Conv, messages: Msg[]): boolean {
    const last = messages.at(-1);
    if (!last || last.role !== "tool") return false;
    const results = last.content.flatMap((b) => (b.type === "tool_result" ? [b] : []));
    const waiting = new Map(conv.awaiting.map((c) => [c.id, c]));
    if (results.length !== waiting.size || !results.every((r) => waiting.has(r.toolUseId))) return false;
    const images = last.content.flatMap((b) => (b.type === "image" ? [{ mime: b.mime, data: b.data }] : []));
    // a picture belongs with the camera call; if there is none it goes with the first answer
    const owner = conv.awaiting.find((c) => c.name === "camera.snap") ?? conv.awaiting[0];
    for (const r of results) waiting.get(r.toolUseId)!.respond({ text: r.content, isError: r.isError, ...(images.length && waiting.get(r.toolUseId) === owner ? { images } : {}) });
    conv.awaiting = [];
    return true;
  }

  /** Something else came instead of the answers: tell Claude those calls were cancelled and let it finish. */
  private async cancelPending(conv: Conv): Promise<void> {
    for (const c of conv.awaiting) c.respond({ text: "Error: cancelled by the owner.", isError: true });
    conv.awaiting = [];
    await this.drain(conv);
  }

  private abandonStep(conv: Conv, collected: BridgeCall[]): void {
    for (const c of collected) c.respond({ text: "Error: cancelled by the owner.", isError: true });
    for (const c of conv.awaiting) c.respond({ text: "Error: cancelled by the owner.", isError: true });
    conv.awaiting = [];
    if (conv.proc?.alive && !conv.draining) conv.draining = this.drain(conv).finally(() => (conv.draining = null));
  }

  /** Reads and discards what Claude does until it has finished its turn, so the next message starts clean. */
  private async drain(conv: Conv): Promise<void> {
    const deadline = this.now() + DRAIN_MS;
    while (conv.proc?.alive) {
      const item = await conv.inbox.next(Math.max(1, deadline - this.now()), undefined);
      if (item === "timeout") {
        conv.proc.kill();
        conv.proc = null;
        break;
      }
      if (item === "abort") continue;
      if (item.kind === "call") item.call.respond({ text: "Error: cancelled by the owner.", isError: true });
      else if (item.kind === "exit") break;
      else if (item.ev.type === "result") break;
    }
    conv.inbox.clear();
  }

  // ---- the process ----

  private async ensureProcess(conv: Conv, req: StreamRequest): Promise<void> {
    const toolsKey = conv.guest ? "" : toolsKeyOf(req.tools);
    if (!conv.guest && conv.proc?.alive && conv.systemKey === req.system && conv.toolsKey === toolsKey) return;
    if (conv.proc) {
      // the instructions or tools changed: restart, and resume so the conversation carries on
      conv.proc.kill();
      await conv.proc.exited;
      conv.proc = null;
    }
    conv.inbox.clear();
    mkdirSync(this.home, { recursive: true });
    if (!conv.guest) {
      conv.sessionId ??= this.readSession();
      this.fresh = conv.sessionId ? null : this.readFresh();
      await this.startBridge();
      this.bridge.setTools(req.tools);
    }
    const resume = conv.guest ? null : conv.sessionId;
    const model = this.opts.model ?? "sonnet";
    const web = !conv.guest && !!this.opts.webSearch;
    const args = [
      ...(this.opts.commandArgs ?? []),
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", model,
      "--strict-mcp-config", "--disable-slash-commands", "--tools", web ? "WebSearch" : "", "--setting-sources", "local",
      "--system-prompt", req.system,
      ...(conv.guest
        ? ["--no-session-persistence"]
        : ["--mcp-config", join(this.home, "mcp.json"), "--allowedTools", [...(web ? ["WebSearch"] : []), ...req.tools.map((t) => `mcp__friend__${encodeToolName(t.name)}`)].join(","), ...(resume ? ["--resume", resume] : [])]),
    ];
    const proc: ClaudeProc = new ClaudeProc(
      {
        command: this.opts.command ?? "claude",
        args,
        cwd: this.home,
        env: { ...process.env, ...this.opts.env, MCP_TOOL_TIMEOUT: String(this.opts.toolTimeoutMs ?? 900_000) },
      },
      // anything from a process that has been replaced or killed (its "exited" notice, say) must not reach a newer request
      (item) => {
        if (conv.proc === proc) conv.inbox.push(item);
      },
    );
    conv.proc = proc;
    if (conv.guest) this.guests.add(proc);
    conv.systemKey = req.system;
    conv.toolsKey = toolsKey;
    conv.startedWithResume = !!resume;
    conv.hasContext = !!resume;
    conv.gotEvent = false;
  }

  private endGuest(conv: Conv): void {
    if (!conv.proc) return;
    this.guests.delete(conv.proc);
    conv.proc.kill();
    conv.proc = null;
  }

  private startBridge(): Promise<void> {
    this.bridgeReady ??= (async () => {
      await this.bridge.start();
      const file = join(this.home, "mcp.json");
      writeFileSync(file, JSON.stringify({ mcpServers: { friend: { type: "http", url: this.bridge.url, headers: { Authorization: `Bearer ${this.bridge.token}` } } } }));
      try {
        chmodSync(file, 0o600); // the token inside is a secret
      } catch {
        /* not every system supports it */
      }
    })();
    return this.bridgeReady;
  }

  // ---- the session id, kept so a restart of Friend can pick the conversation up again ----

  private sessionFile = () => join(this.home, "session-id");
  private readSession(): string | null {
    try {
      return existsSync(this.sessionFile()) ? readFileSync(this.sessionFile(), "utf8").trim() || null : null;
    } catch {
      return null;
    }
  }
  private rememberSession(conv: Conv, id: string): void {
    if (conv.guest || conv.sessionId === id) return;
    conv.sessionId = id;
    this.fresh = null; // the new conversation has begun: it carries the summary from here on
    try {
      rmSync(this.freshFile(), { force: true });
    } catch {
      /* nothing to remove */
    }
    try {
      writeFileSync(this.sessionFile(), id);
    } catch {
      /* losing it only costs a seeded restart later */
    }
  }
  private freshFile = () => join(this.home, "fresh.json");
  private readFresh(): { seed: string | null } | null {
    try {
      if (!existsSync(this.freshFile())) return null;
      const r = JSON.parse(readFileSync(this.freshFile(), "utf8")) as { seed?: unknown };
      return { seed: typeof r.seed === "string" && r.seed ? r.seed : null };
    } catch {
      return null;
    }
  }
  private forgetSession(conv: Conv): void {
    conv.sessionId = null;
    try {
      rmSync(this.sessionFile(), { force: true });
    } catch {
      /* nothing to forget */
    }
  }

  // ---- what to tell Claude ----

  /** What is new since Claude last answered, as the content of one user message. */
  private userContent(req: StreamRequest, conv: Conv): unknown[] {
    const msgs = req.messages;
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (writtenByClaude(msgs[i]!)) {
        last = i;
        break;
      }
    }
    const blocks: unknown[] = [];
    const fresh = conv.hasContext ? null : this.fresh;
    if (fresh) {
      if (fresh.seed) blocks.push({ type: "text", text: `Summary of our earlier conversation (for context only, it is already over):\n${fresh.seed}` });
    } else if (!conv.hasContext && last >= 0) blocks.push({ type: "text", text: transcript(msgs.slice(0, last + 1)) });

    const ran = new Map<string, string>();
    for (const m of msgs.slice(last + 1)) {
      for (const b of m.content) {
        if (m.role === "user" && b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "image") blocks.push({ type: "image", source: { type: "base64", media_type: b.mime, data: b.data } });
        else if (b.type === "tool_use") ran.set(b.id, `${b.name} ${JSON.stringify(b.input)}`);
        else if (b.type === "tool_result") {
          // data Friend fetched itself (weather, system stats): Claude was not asked, so it is told what happened
          blocks.push({ type: "text", text: `[Friend already ran ${ran.get(b.toolUseId) ?? "a tool"}${b.isError ? " and it failed" : ""}. Result:]\n${b.content}` });
        }
      }
    }
    if (req.context) blocks.push({ type: "text", text: req.context });
    return blocks.length ? blocks : [{ type: "text", text: "(continue)" }];
  }
}

/** The earlier conversation as plain text, for a Claude that has not seen it. */
function transcript(messages: Msg[]): string {
  const lines: string[] = [];
  for (const m of messages.slice(-20)) {
    const t = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
    if (!t) continue;
    lines.push(`${m.role === "user" ? "Owner" : "You"}: ${t}`);
  }
  return `Earlier conversation (for context only, it is already over):\n${lines.join("\n").slice(-6000)}`;
}
