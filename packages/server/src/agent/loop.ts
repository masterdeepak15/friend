import type { ServerMsg, Tier, ToolDef, Trust } from "@friend/protocol";
import type { Approvals } from "../approvals";
import type { Audit } from "../audit";
import type { CameraBroker } from "../camera";
import type { CodeBox } from "../codebox";
import type { Plugins } from "../plugins";
import type { Config } from "../config";
import type { Db } from "../db";
import type { Memory } from "../memory";
import { localIso, type Tasks } from "../tasks";
import type { DeviceHub } from "../devices";
import { classifyShell } from "../policy/classify";
import type { PolicyEngine } from "../policy/engine";
import type { ContentBlock, Msg, Provider } from "../provider/types";
import { runStageTool, type StageState } from "../stage";
import { getToolDef, lexicalInsideRoots, pathArg, toolSpecs } from "../tools/registry";
import { loadHistory, repairDangling, saveMessage } from "./history";
import { promptParts } from "./prompt";

export const MAX_STEPS = 20;
/** How many of the newest notes go into every prompt; older ones are found with memory.search. */
export const NOTES_IN_PROMPT = 20;
/** Largest tool result sent back to the model; older, bigger results would otherwise swamp every later turn. */
export const MAX_RESULT_CHARS = 24_000;

export interface AgentDeps {
  provider: Provider;
  policy: PolicyEngine;
  approvals: Approvals;
  devices: Pick<DeviceHub, "exec" | "hasOnline" | "targetName">;
  stage: StageState;
  db: Db;
  audit: Audit;
  config: Config;
  assistantName: () => string;
  /** Takes one picture through the owner's browser. Without it the camera tool reports it is unavailable. */
  camera?: Pick<CameraBroker, "request">;
  /** The owner's saved notes. Without it the memory tools report they are unavailable. */
  memory?: Memory;
  /** The owner's to-dos and reminders. Without it the task tools report they are unavailable. */
  tasks?: Tasks;
  /** Runs programs in a throwaway container. Without it the code tool reports it is unavailable. */
  code?: Pick<CodeBox, "run">;
  /** Installed plugins: their skills go into the prompt and their tools join the tool list. */
  plugins?: Plugins;
}

export interface TurnCtx {
  trust: Trust;
  emit: (m: ServerMsg) => void;
  ip: string;
}

interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

const clipArgs = (args: unknown): unknown =>
  JSON.parse(JSON.stringify(args ?? {}, (_k, v) => (typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v)));

export class Agent {
  private busy = false;
  private abort: AbortController | null = null;

  constructor(private deps: AgentDeps) {}

  isBusy(): boolean {
    return this.busy;
  }

  /** Stop the running turn (used by emergency lock). */
  cancel(): void {
    this.abort?.abort();
  }

  async runTurn(text: string, ctx: TurnCtx): Promise<void> {
    const { emit } = ctx;
    const d = this.deps;
    if (this.busy) {
      emit({ type: "status", busy: true, deviceOnline: d.devices.hasOnline(), message: "Still busy with the previous request" });
      return;
    }
    this.busy = true;
    const stage = (cmd: Parameters<StageState["apply"]>[0]) => {
      d.stage.apply(cmd);
      emit({ type: "stage", command: cmd });
    };
    emit({ type: "status", busy: true, deviceOnline: d.devices.hasOnline() });
    stage({ cmd: "presence", state: "thinking" });
    const abort = new AbortController();
    this.abort = abort;
    // An unverified speaker gets an isolated conversation: no owner history in, nothing stored out.
    const guest = ctx.trust === "guest";
    const keep = (m: Msg) => {
      if (!guest) saveMessage(d.db, m);
    };
    try {
      if (!guest) repairDangling(d.db);
      const userMsg: Msg = { role: "user", content: [{ type: "text", text }] };
      keep(userMsg);
      const messages: Msg[] = guest ? [userMsg] : loadHistory(d.db);
      const pluginTools = (d.plugins?.toolDefs() ?? []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      const tools = ctx.trust === "owner" ? [...toolSpecs(), ...pluginTools] : [];

      for (let step = 0; step < MAX_STEPS; step++) {
        let assistantText = "";
        const calls: ToolCall[] = [];
        let failed: string | null = null;
        let userFacing = false;
        // read fresh each step, so a note saved earlier in this turn is visible right away; guests never see notes
        const notes = !guest && d.memory ? d.memory.recent(NOTES_IN_PROMPT).map((m) => `#${m.id} ${m.text}`) : undefined;
        const { system, context } = promptParts(
          d.assistantName(),
          d.stage.summary(),
          guest ? "guest" : "owner",
          notes,
          localIso(new Date(d.tasks?.now() ?? Date.now())),
          guest ? undefined : d.plugins?.skills(),
        );
        for await (const ev of d.provider.stream({ system, ...(context ? { context } : {}), messages, tools, signal: abort.signal })) {
          if (ev.type === "text_delta") {
            if (!assistantText) stage({ cmd: "presence", state: "speaking" });
            assistantText += ev.text;
            emit({ type: "caption.delta", text: ev.text });
          } else if (ev.type === "tool_call") calls.push({ id: ev.id, name: ev.name, args: ev.args });
          else if (ev.type === "error") {
            failed = ev.message;
            userFacing = !!ev.userFacing;
            break;
          }
        }
        if (abort.signal.aborted) return;
        if (failed !== null) {
          d.audit.log("agent", "provider.error", { message: failed });
          emit({
            type: "caption.delta",
            text: userFacing
              ? failed
              : assistantText
                ? "\n\nSorry, I lost my connection to the model."
                : "Sorry, I could not reach the model just now.",
          });
          return;
        }
        const content: ContentBlock[] = [];
        if (assistantText) content.push({ type: "text", text: assistantText });
        for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
        const assistantMsg: Msg = { role: "assistant", content };
        messages.push(assistantMsg);
        if (content.length) keep(assistantMsg);
        if (calls.length === 0) return;

        stage({ cmd: "presence", state: "thinking" });
        const results: ContentBlock[] = [];
        const pictures: ContentBlock[] = [];
        for (const c of calls) {
          if (abort.signal.aborted) return;
          const r = await this.executeTool(c, ctx, abort.signal);
          results.push({ type: "tool_result", toolUseId: c.id, content: r.text, isError: r.isError });
          if (r.image) pictures.push({ type: "image", mime: r.image.mime, data: r.image.data });
        }
        // pictures follow all the tool results; they are shown to the model now and never stored
        const toolMsg: Msg = { role: "tool", content: [...results, ...pictures] };
        messages.push(toolMsg);
        keep(toolMsg);
        if (step === MAX_STEPS - 1) {
          emit({ type: "alert", level: "warn", text: `Stopped after ${MAX_STEPS} steps without finishing.` });
        }
      }
    } catch (e) {
      d.audit.log("system", "agent.error", { message: (e as Error).message });
      emit({ type: "caption.delta", text: "Sorry, something went wrong on my side." });
    } finally {
      emit({ type: "caption.end" });
      stage({ cmd: "presence", state: "idle" });
      this.busy = false;
      emit({ type: "status", busy: false, deviceOnline: d.devices.hasOnline() });
    }
  }

  private runTaskTool(name: string, args: Record<string, unknown>): { ok: boolean; text: string } {
    const { tasks, audit } = this.deps;
    if (!tasks) return { ok: false, text: "Tasks are not available." };
    const describe = (t: { dueAt: number | null; repeat: string | null }) =>
      t.dueAt === null ? "" : ` (due ${localIso(new Date(t.dueAt))}${t.repeat ? `, repeats ${t.repeat}` : ""})`;

    if (name === "task.add") {
      const { title, inMinutes, dueAt, repeat } = args as { title: string; inMinutes?: number; dueAt?: string; repeat?: "hourly" | "daily" | "weekly" };
      if (inMinutes !== undefined && dueAt !== undefined) return { ok: false, text: "Give either inMinutes or dueAt, not both." };
      let due: number | null = null;
      if (inMinutes !== undefined) due = tasks.now() + inMinutes * 60_000;
      if (dueAt !== undefined) {
        // a time without an offset would silently be read in the wrong zone
        if (!/(Z|[+-]\d\d:?\d\d)$/i.test(dueAt) || Number.isNaN(Date.parse(dueAt))) {
          return { ok: false, text: "Give the time as ISO 8601 with an offset, like 2026-10-09T17:00:00+05:30." };
        }
        due = Date.parse(dueAt);
      }
      const r = tasks.add({ title, dueAt: due, repeat });
      if (!r.ok) return { ok: false, text: r.error };
      audit.log("agent", "task.add", { id: r.id, due, repeat: repeat ?? null });
      return { ok: true, text: `Added task #${r.id}${describe({ dueAt: due, repeat: repeat ?? null })}.` };
    }
    if (name === "task.list") {
      const open = tasks.list();
      return { ok: true, text: open.length ? open.map((t) => `#${t.id} ${t.title}${describe(t)}`).join("\n") : "No open tasks." };
    }
    if (name === "task.done") {
      const id = Number(args.id);
      const r = tasks.done(id);
      if (!r.ok) return { ok: false, text: r.error };
      audit.log("agent", "task.done", { id });
      const next = r.rescheduled ? tasks.list().find((t) => t.id === id) : undefined;
      return { ok: true, text: r.rescheduled && next?.dueAt ? `Marked #${id} done. Next reminder: ${localIso(new Date(next.dueAt))}.` : `Marked #${id} done.` };
    }
    if (name === "task.remove") {
      const id = Number(args.id);
      if (!tasks.remove(id)) return { ok: false, text: "No task with that number." };
      audit.log("agent", "task.remove", { id });
      return { ok: true, text: `Removed task #${id}.` };
    }
    return { ok: false, text: `Unknown tool: ${name}` };
  }

  private runMemoryTool(name: string, args: Record<string, unknown>): { ok: boolean; text: string } {
    const { memory, audit } = this.deps;
    if (!memory) return { ok: false, text: "Memory is not available." };
    if (name === "memory.remember") {
      const text = String(args.text);
      const r = memory.add(text, "agent");
      if (!r.ok) return { ok: false, text: r.error };
      audit.log("agent", "memory.remember", { id: r.id, length: text.length, duplicate: r.duplicate });
      return { ok: true, text: r.duplicate ? `Already remembered (#${r.id}).` : `Remembered (#${r.id}).` };
    }
    if (name === "memory.search") {
      const found = memory.search(String(args.query));
      return { ok: true, text: found.length ? found.map((m) => `#${m.id} ${m.text}`).join("\n") : "No matching notes." };
    }
    if (name === "memory.forget") {
      const id = Number(args.id);
      if (!memory.forget(id)) return { ok: false, text: "No note with that number." };
      audit.log("agent", "memory.forget", { id });
      return { ok: true, text: `Forgot note #${id}.` };
    }
    return { ok: false, text: `Unknown tool: ${name}` };
  }

  private async executeTool(
    call: ToolCall,
    ctx: TurnCtx,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean; image?: { mime: string; data: string } }> {
    const d = this.deps;
    const fail = (error: string) => ({ text: `Error: ${error}`, isError: true });
    const plugin = call.name.startsWith("plugin.") ? d.plugins?.tool(call.name) : undefined;
    // every plugin tool needs the owner's approval, whatever the plugin says about itself
    const def: ToolDef | undefined = plugin
      ? { name: plugin.name, description: plugin.description, input: plugin.input, baseTier: "T2", target: "gateway" }
      : getToolDef(call.name);
    if (!def) return fail(`Unknown tool: ${call.name}`);
    const parsed = def.input.safeParse(call.args ?? {});
    if (!parsed.success) return fail(`Invalid arguments for ${call.name}: ${parsed.error.message}`);
    const args = parsed.data as Record<string, unknown>;

    let tier: Tier = def.baseTier;
    if (call.name === "shell.run") tier = classifyShell(String(args.command), d.config.destructivePatterns);
    const p = pathArg(call.name, args);
    const insideRoots = p === undefined ? true : lexicalInsideRoots(p, d.config.roots);

    const decision = d.policy.decide({ tool: call.name, baseTier: tier, args, trust: ctx.trust, insideRoots });
    let approvedOutside = false;
    const device = def.target === "device" ? d.devices.targetName() : null;
    if (decision === "deny") {
      d.audit.log("agent", "tool.denied", { tool: call.name, args: clipArgs(args), trust: ctx.trust });
      return fail("This action is not allowed.");
    }
    if ((call.name === "code.run" || plugin) && !d.code) return fail("Running code is not available.");
    if (call.name === "camera.snap") {
      // refuse before bothering the owner with a card for a picture that could not be used
      if (!d.camera) return fail("The camera is not available.");
      if (!d.provider.vision) {
        return fail("This model cannot look at pictures. Use a vision model (Claude, or an Ollama vision model with ollama.vision true).");
      }
    }
    if (decision === "ask" || decision === "ask_with_pin") {
      const outcome = await d.approvals.request(
        { tool: call.name, args, tier: !insideRoots && tier !== "T3" ? "T2" : tier, needsPin: decision === "ask_with_pin", device },
        ctx.emit,
      );
      if (!outcome.approved) {
        d.audit.log("agent", "tool.not_approved", { tool: call.name, args: clipArgs(args), reason: outcome.reason });
        return fail(`The owner did not approve this action (${outcome.reason ?? "denied"}).`);
      }
      approvedOutside = !insideRoots;
    }

    if (call.name === "code.run") {
      const { language, code, timeoutSec } = args as { language: "python" | "node" | "shell"; code: string; timeoutSec?: number };
      const r = await d.code!.run({ language, code, timeoutSec });
      d.audit.log("agent", "tool.call", { tool: call.name, args: { language, chars: code.length }, tier, ok: r.ok });
      if (!r.ok) return fail(r.error);
      const parts = [r.timedOut ? "Stopped: it ran past the time limit." : `exit code ${r.exitCode}`];
      if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`);
      if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
      return { text: parts.join("\n"), isError: false };
    }

    if (plugin) {
      // the plugin's program runs in the same throwaway container as code.run; its arguments arrive as /work/args.json
      const r = await d.code!.run({ language: plugin.language, code: plugin.code, timeoutSec: 20, files: { "args.json": JSON.stringify(args) } });
      d.audit.log("agent", "tool.call", { tool: call.name, args: clipArgs(args), tier, ok: r.ok && !r.timedOut && r.exitCode === 0 });
      if (!r.ok) return fail(r.error);
      if (r.timedOut) return fail("The plugin tool ran past its time limit.");
      if (r.exitCode !== 0) return fail(`The plugin tool failed (exit code ${r.exitCode}).${r.stderr ? `\n${r.stderr}` : ""}`);
      return { text: r.stdout || "(no output)", isError: false };
    }

    if (call.name === "skill.use") {
      const text = d.plugins?.skillText(String(args.plugin), String(args.name));
      if (!text) return fail("No such skill.");
      d.audit.log("agent", "skill.use", { plugin: args.plugin, name: args.name });
      return { text, isError: false };
    }

    if (call.name.startsWith("memory.") || call.name.startsWith("task.")) {
      const out = call.name.startsWith("memory.") ? this.runMemoryTool(call.name, args) : this.runTaskTool(call.name, args);
      return out.ok ? { text: out.text, isError: false } : fail(out.text);
    }

    if (call.name === "camera.snap") {
      const shot = await d.camera!.request(ctx.emit, signal);
      d.audit.log("agent", "tool.call", { tool: call.name, args: {}, tier, ok: shot.ok });
      return shot.ok ? { text: "Picture taken.", isError: false, image: { mime: shot.mime, data: shot.data } } : fail(shot.error);
    }

    const result =
      def.target === "gateway"
        ? runStageTool(call.name, args, d.stage, ctx.emit)
        : await d.devices.exec(call.name, args, call.name === "shell.run" ? 70_000 : 30_000, {
            approvedOutside,
            expectDevice: device ?? undefined,
          });
    d.audit.log("agent", "tool.call", { tool: call.name, args: clipArgs(args), tier, ok: result.ok });
    if (!result.ok) return fail(result.error);
    const capped = result.output.length > MAX_RESULT_CHARS;
    const output = capped ? result.output.slice(0, MAX_RESULT_CHARS) : result.output;
    return { text: result.truncated || capped ? `${output}\n[output truncated]` : output, isError: false };
  }
}
