import type { ServerMsg, Tier, Trust } from "@friend/protocol";
import type { Approvals } from "../approvals";
import type { Audit } from "../audit";
import type { Config } from "../config";
import type { Db } from "../db";
import type { DeviceHub } from "../devices";
import { classifyShell } from "../policy/classify";
import type { PolicyEngine } from "../policy/engine";
import type { ContentBlock, Msg, Provider } from "../provider/types";
import { runStageTool, type StageState } from "../stage";
import { getToolDef, lexicalInsideRoots, pathArg, toolSpecs } from "../tools/registry";
import { loadHistory, repairDangling, saveMessage } from "./history";
import { buildSystemPrompt } from "./prompt";

export const MAX_STEPS = 20;

export interface AgentDeps {
  provider: Provider;
  policy: PolicyEngine;
  approvals: Approvals;
  devices: Pick<DeviceHub, "exec" | "hasOnline">;
  stage: StageState;
  db: Db;
  audit: Audit;
  config: Config;
  assistantName: () => string;
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
    try {
      repairDangling(d.db);
      saveMessage(d.db, { role: "user", content: [{ type: "text", text }] });
      const messages: Msg[] = loadHistory(d.db);
      const tools = ctx.trust === "owner" ? toolSpecs() : [];

      for (let step = 0; step < MAX_STEPS; step++) {
        let assistantText = "";
        const calls: ToolCall[] = [];
        let failed: string | null = null;
        let userFacing = false;
        const system = buildSystemPrompt(d.assistantName(), d.stage.summary());
        for await (const ev of d.provider.stream({ system, messages, tools, signal: abort.signal })) {
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
        if (content.length) saveMessage(d.db, assistantMsg);
        if (calls.length === 0) return;

        stage({ cmd: "presence", state: "thinking" });
        const results: ContentBlock[] = [];
        for (const c of calls) {
          if (abort.signal.aborted) return;
          const r = await this.executeTool(c, ctx);
          results.push({ type: "tool_result", toolUseId: c.id, content: r.text, isError: r.isError });
        }
        const toolMsg: Msg = { role: "tool", content: results };
        messages.push(toolMsg);
        saveMessage(d.db, toolMsg);
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

  private async executeTool(call: ToolCall, ctx: TurnCtx): Promise<{ text: string; isError: boolean }> {
    const d = this.deps;
    const fail = (error: string) => ({ text: `Error: ${error}`, isError: true });
    const def = getToolDef(call.name);
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
    if (decision === "deny") {
      d.audit.log("agent", "tool.denied", { tool: call.name, args: clipArgs(args), trust: ctx.trust });
      return fail("This action is not allowed.");
    }
    if (decision === "ask" || decision === "ask_with_pin") {
      const outcome = await d.approvals.request(
        { tool: call.name, args, tier: !insideRoots && tier !== "T3" ? "T2" : tier, needsPin: decision === "ask_with_pin" },
        ctx.emit,
      );
      if (!outcome.approved) {
        d.audit.log("agent", "tool.not_approved", { tool: call.name, args: clipArgs(args), reason: outcome.reason });
        return fail(`The owner did not approve this action (${outcome.reason ?? "denied"}).`);
      }
      approvedOutside = !insideRoots;
    }

    const result =
      def.target === "gateway"
        ? runStageTool(call.name, args, d.stage, ctx.emit)
        : await d.devices.exec(call.name, args, call.name === "shell.run" ? 70_000 : 30_000, { approvedOutside });
    d.audit.log("agent", "tool.call", { tool: call.name, args: clipArgs(args), tier, ok: result.ok });
    if (!result.ok) return fail(result.error);
    return { text: result.truncated ? `${result.output}\n[output truncated]` : result.output, isError: false };
  }
}
