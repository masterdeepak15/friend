import type { OfficeQuota, OfficeTicketView, OfficeWorkerView, ServerMsg, TicketStatus, WorkerStatus } from "@friend/protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Approvals } from "../approvals";
import type { Audit } from "../audit";
import type { Config } from "../config";
import { ToolBridge, type BridgeCall, type BridgeTool } from "../provider/claude-code/bridge";
import type { WorkerEvent } from "./events";
import { summarizeToolCall } from "./events";
import { decideAction } from "./gate";
import { WorkerProc, buildWorkerArgs, type WorkerExit } from "./runner";
import type { OfficeStore, TicketRow, WorkerRow } from "./store";

/** What the supervisor needs of a running worker (the real one is a WorkerProc). */
export interface WorkerLike {
  send(text: string): void;
  kill(): void;
  readonly alive: boolean;
  readonly exited: Promise<void>;
}
/** What it needs of the little MCP server one worker asks its questions through (the real one is a ToolBridge). */
export interface BridgeLike {
  readonly url: string;
  readonly token: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  setTools(tools: BridgeTool[]): void;
  failPending(reason: string): void;
}
export type WorkerFactory = (o: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }, onEvent: (e: WorkerEvent) => void, onExit: (x: WorkerExit) => void) => WorkerLike;
export type BridgeFactory = (onCall: (call: BridgeCall) => void) => BridgeLike;

export interface OfficeDeps {
  config: () => Config;
  store: OfficeStore;
  approvals: Pick<Approvals, "request" | "denyWhere">;
  audit: Pick<Audit, "log">;
  /** Gets the tokens a run used (counts only, never words). */
  usage: (e: { source: string; input: number; output: number }) => void;
  emit: (m: ServerMsg) => void;
  spawn?: WorkerFactory;
  bridge?: BridgeFactory;
  /** Where the per-worker MCP files are kept. */
  dataDir: string;
}

type FeedKind = Extract<ServerMsg, { type: "office.feed" }>["kind"];
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

interface QueueEntry {
  workerId: string;
  ticketId: number;
  /** The owner's note when a ticket was sent back. */
  note?: string;
}
interface Run {
  workerId: string;
  ticketId: number;
  proc: WorkerLike | null;
  bridge: BridgeLike;
  startTimer: ReturnType<typeof setTimeout> | null;
  spoke: boolean;
  pending: number;
  concluded: boolean;
  /** Messages sent to the worker (the ticket first) and answers received: the run ends when every message has been answered. */
  sent: number;
  answered: number;
}

const OFF = "The Office is switched off in Settings.";
const STATE_EVERY_MS = 200;
const DETAIL_CHARS = 80;
const FEED_CHARS = 200;
const APPROVE_SPEC: BridgeTool = {
  name: "approve",
  description: "Ask Friend whether an action may run. Friend answers for its owner.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } }, required: ["tool_name", "input"] },
};
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** What the owner is shown to approve: a shell command in full, a file action by its path. */
function describeAction(tool: string, input: Record<string, unknown>): string {
  if (typeof input.command === "string") return `run the shell command: ${input.command}`;
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
  if (file) return `${tool} ${file}`;
  const rest = JSON.stringify(input);
  return rest && rest !== "{}" ? `use ${tool} with ${clip(rest, 2000)}` : `use ${tool}`; // whatever else it will be given is shown too
}

/**
 * The Office: Friend's hired workers. It starts each worker as a Claude Code process in the project folder, answers the questions the
 * process asks before risky actions (the gate, then the owner), follows what it does, and keeps within the owner's limits. Everything
 * it does is read from settings at the moment it does it.
 */
/** What Friend's own tools use of the Office. */
export type OfficeApi = Pick<Office, "hire" | "assign" | "say" | "review" | "stop" | "status">;

export class Office {
  private runs = new Map<string, Run>();
  private queue: QueueEntry[] = [];
  private quota: OfficeQuota = { fiveHour: null, sevenDay: null };
  private pauseAlerted = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private down = false;
  private spawnWorker: WorkerFactory;
  private makeBridge: BridgeFactory;

  constructor(private d: OfficeDeps) {
    this.spawnWorker = d.spawn ?? ((o, onEvent, onExit) => new WorkerProc({ command: o.command, args: o.args, cwd: o.cwd, ...(o.env ? { env: o.env } : {}) }, onEvent, onExit));
    this.makeBridge = d.bridge ?? ((onCall) => new ToolBridge(onCall));
    d.store.resetRunning(); // whatever a crash left running is stopped
  }

  private get cfg() {
    return this.d.config().office;
  }

  // ---- what Friend and the owner ask for ----

  hire(a: { role: string; project: string; name?: string }): Result<{ worker: OfficeWorkerView }> {
    if (!this.cfg.enabled) return { ok: false, error: OFF };
    const role = this.cfg.roles.find((r) => r.id === a.role);
    if (!role) return { ok: false, error: `There is no role "${a.role}". The roles are: ${this.cfg.roles.map((r) => r.id).join(", ") || "(none set up)"}.` };
    const project = this.cfg.projects.find((p) => p.id === a.project);
    if (!project) return { ok: false, error: `There is no project "${a.project}". The projects are: ${this.cfg.projects.map((p) => p.id).join(", ") || "(none set up)"}.` };
    try {
      if (!statSync(project.folder).isDirectory()) throw new Error("not a folder");
    } catch {
      return { ok: false, error: `The folder of the project ${project.name} was not found: ${project.folder}` };
    }
    const taken = new Set(this.d.store.listWorkers().map((w) => w.name.toLowerCase()));
    let name = (a.name ?? "").trim().slice(0, 30);
    if (name && taken.has(name.toLowerCase())) return { ok: false, error: `There is already a worker named ${name}.` };
    if (!name) {
      let n = this.d.store.listWorkers().filter((w) => w.roleId === role.id).length + 1;
      while (taken.has(`${role.title} ${n}`.toLowerCase())) n++;
      name = `${role.title} ${n}`.slice(0, 30);
    }
    const w = this.d.store.createWorker({ name, roleId: role.id, projectId: project.id });
    this.d.audit.log("agent", "office.hire", { worker: w.id, role: role.id, project: project.id });
    this.changed();
    return { ok: true, worker: this.workerView(w) };
  }

  assign(a: { worker: string; title: string; description?: string }): Result<{ ticket: OfficeTicketView; queued: boolean }> {
    if (!this.cfg.enabled) return { ok: false, error: OFF };
    const worker = this.d.store.findWorker(a.worker);
    if (!worker) return { ok: false, error: this.noWorker(a.worker) };
    const ticket = this.d.store.createTicket({ projectId: worker.projectId, title: clip(a.title.trim(), 200), description: clip(a.description ?? "", 4000) });
    this.d.store.patchTicket(ticket.id, { workerId: worker.id });
    this.d.audit.log("agent", "office.assign", { worker: worker.id, ticket: ticket.id });
    this.queue.push({ workerId: worker.id, ticketId: ticket.id });
    this.pump();
    this.changed();
    const now = this.d.store.getTicket(ticket.id)!;
    return { ok: true, ticket: this.d.store.ticketView(now), queued: now.status === "todo" };
  }

  /** Says something to a worker: straight into a running worker's conversation, or as a new ticket for one that is idle. */
  say(workerRef: string, text: string): { ok: boolean; error?: string } {
    if (!this.cfg.enabled) return { ok: false, error: OFF };
    const worker = this.d.store.findWorker(workerRef);
    if (!worker) return { ok: false, error: this.noWorker(workerRef) };
    const run = this.runs.get(worker.id);
    if (run?.proc && !run.concluded) {
      run.proc.send(text);
      run.sent++;
      this.feed(worker.id, "text", `You: ${text}`);
      this.d.audit.log("agent", "office.say", { worker: worker.id });
      return { ok: true };
    }
    const r = this.assign({ worker: worker.id, title: `Message: ${clip(text, 60)}`, description: text });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  review(ticketId: number, accept: boolean, note?: string): { ok: boolean; error?: string } {
    const t = this.d.store.getTicket(ticketId);
    if (!t) return { ok: false, error: `There is no ticket #${ticketId}.` };
    if (t.status !== "review") return { ok: false, error: `Ticket #${ticketId} is not waiting for review (it is ${t.status}).` };
    this.d.audit.log("agent", "office.review", { ticket: ticketId, accept });
    if (accept) {
      this.d.store.patchTicket(ticketId, { status: "done" });
    } else {
      this.d.store.patchTicket(ticketId, { status: "todo" });
      if (t.workerId) this.queue.push({ workerId: t.workerId, ticketId, ...(note ? { note } : {}) });
    }
    this.pump();
    this.changed();
    return { ok: true };
  }

  /** Stops one worker, or every worker when none is named. */
  stop(workerRef?: string, by: "agent" | "owner" = "agent"): { stopped: number } {
    let targets: Run[];
    if (workerRef === undefined) {
      this.queue = []; // nothing waiting may start behind the stop; those tickets stay on the list
      targets = [...this.runs.values()];
    } else {
      const worker = this.d.store.findWorker(workerRef);
      if (!worker) return { stopped: 0 };
      this.queue = this.queue.filter((e) => e.workerId !== worker.id);
      targets = [this.runs.get(worker.id)].filter((r): r is Run => !!r);
    }
    for (const run of targets) this.conclude(run, { worker: "stopped", ticket: "todo", feed: { kind: "text", text: "Stopped." } });
    this.d.audit.log(by, "office.stop", { worker: workerRef ?? "all", stopped: targets.length });
    this.changed();
    return { stopped: targets.length };
  }

  status(): { workers: OfficeWorkerView[]; tickets: OfficeTicketView[]; quota: OfficeQuota } {
    return {
      workers: this.d.store.listWorkers().slice(0, 100).map((w) => this.workerView(w)),
      tickets: this.d.store.listTickets().slice(-500).map((t) => this.d.store.ticketView(t)),
      quota: this.quota,
    };
  }

  snapshot(): ServerMsg {
    return { type: "office.state", enabled: this.cfg.enabled, ...this.status() };
  }

  async shutdown(): Promise<void> {
    this.down = true;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.queue = [];
    const runs = [...this.runs.values()];
    const waits = runs.map((r) => r.proc?.exited);
    for (const run of runs) this.conclude(run, { worker: "stopped", ticket: "todo" });
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 3000))]);
  }

  // ---- starting work ----

  private noWorker(ref: string): string {
    const names = this.d.store.listWorkers().map((w) => w.name);
    return `There is no worker "${ref}".${names.length ? ` The workers are: ${names.join(", ")}.` : " Nobody is hired yet."}`;
  }

  private budgetReason(worker: WorkerRow): string | null {
    const b = this.cfg.budget;
    if (b.perWorkerTokens > 0 && worker.tokens >= b.perWorkerTokens) return `${worker.name} has used its budget (${b.perWorkerTokens} tokens).`;
    if (b.totalTokens > 0 && this.d.store.listWorkers().reduce((n, w) => n + w.tokens, 0) >= b.totalTokens) return `The Office has used its total budget (${b.totalTokens} tokens).`;
    return null;
  }

  /** True while the five-hour window is as full as the owner set. */
  private windowBlocked(): boolean {
    const limit = this.cfg.pauseAtWindow;
    const w = this.quota.fiveHour;
    if (limit <= 0 || !w) return false;
    if (w.resetsAt * 1000 <= Date.now()) {
      this.quota = { ...this.quota, fiveHour: null }; // the window has reset: nothing is known until a worker reports again
      return false;
    }
    return w.utilization >= limit;
  }

  private pump(): void {
    if (this.down || !this.cfg.enabled) return;
    const blocked = this.windowBlocked();
    let waiting = false;
    for (let i = 0; i < this.queue.length; ) {
      const entry = this.queue[i]!;
      const worker = this.d.store.getWorker(entry.workerId);
      const ticket = this.d.store.getTicket(entry.ticketId);
      if (!worker || !ticket || ticket.status !== "todo") {
        this.queue.splice(i, 1);
        continue;
      }
      if (this.runs.has(worker.id)) {
        i++; // busy: this ticket waits for its worker
        continue;
      }
      const over = this.budgetReason(worker);
      if (over) {
        this.queue.splice(i, 1);
        this.d.store.patchTicket(ticket.id, { status: "blocked" });
        this.feed(worker.id, "error", over);
        continue;
      }
      if (blocked) {
        waiting = true;
        this.d.store.patchWorker(worker.id, { status: "paused", detail: "Waiting for the usage window" });
        i++;
        continue;
      }
      if (this.runs.size >= this.cfg.maxConcurrent) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.startRun(worker, ticket, entry.note);
    }
    if (blocked && waiting) this.announcePause();
    if (!blocked) {
      this.pauseAlerted = false;
      for (const w of this.d.store.listWorkers()) if (w.status === "paused" && !this.runs.has(w.id) && !this.queue.some((e) => e.workerId === w.id)) this.d.store.patchWorker(w.id, { status: "idle", detail: "" });
    }
    this.changed();
  }

  private announcePause(): void {
    const w = this.quota.fiveHour!;
    const resetMs = w.resetsAt * 1000;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.pump(), Math.max(1000, resetMs - Date.now() + 1000));
    if (this.pauseAlerted) return;
    this.pauseAlerted = true;
    const at = new Date(resetMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    this.d.emit({ type: "alert", level: "warn", text: `The Office is waiting: your five-hour usage is at ${Math.round(w.utilization * 100)}% (the limit is ${Math.round(this.cfg.pauseAtWindow * 100)}%). It starts again at ${at}.` });
  }

  private startRun(worker: WorkerRow, ticket: TicketRow, note?: string): void {
    const o = this.cfg;
    const role = o.roles.find((r) => r.id === worker.roleId);
    const project = o.projects.find((p) => p.id === worker.projectId);
    if (!role || !project) {
      this.d.store.patchTicket(ticket.id, { status: "blocked" });
      this.feed(worker.id, "error", !role ? `The role "${worker.roleId}" no longer exists.` : `The project "${worker.projectId}" no longer exists.`);
      return;
    }
    this.d.store.patchTicket(ticket.id, { status: "doing", workerId: worker.id });
    this.d.store.patchWorker(worker.id, { status: "starting", ticketId: ticket.id, detail: "Starting", startedAt: Date.now() });
    const run: Run = { workerId: worker.id, ticketId: ticket.id, proc: null, bridge: null as unknown as BridgeLike, startTimer: null, spoke: false, pending: 0, concluded: false, sent: 1, answered: 0 };
    run.bridge = this.makeBridge((call) => void this.onCall(run, call));
    run.bridge.setTools([APPROVE_SPEC]);
    this.runs.set(worker.id, run);
    this.changed();
    const sessionId = this.d.store.getWorker(worker.id)!.sessionId;
    void this.launch(run, worker, ticket, role, project, sessionId, note).catch((e: Error) =>
      this.conclude(run, { worker: "failed", ticket: "blocked", feed: { kind: "error", text: `Could not start: ${e.message}` } }),
    );
  }

  private async launch(run: Run, worker: WorkerRow, ticket: TicketRow, role: Config["office"]["roles"][number], project: Config["office"]["projects"][number], resume: string | null, note?: string): Promise<void> {
    const cfg = this.d.config();
    await run.bridge.start();
    if (run.concluded) return;
    const dir = join(this.d.dataDir, "office");
    mkdirSync(dir, { recursive: true });
    const mcp = join(dir, `${worker.id}.mcp.json`);
    writeFileSync(mcp, JSON.stringify({ mcpServers: { office: { type: "http", url: run.bridge.url, headers: { Authorization: `Bearer ${run.bridge.token}` } } } }));
    const args = buildWorkerArgs({
      model: role.model.trim() || cfg.claudeCode.model,
      instructions: role.instructions,
      permission: role.permission,
      mcpConfigPath: mcp,
      extraFolders: project.extraFolders,
      ...(resume ? { resume } : { sessionId: randomUUID() }),
    });
    const timeoutMs = cfg.office.startTimeoutSec * 1000;
    run.proc = this.spawnWorker({ command: cfg.claudeCode.command, args, cwd: project.folder }, (e) => this.onEvent(run, e), (x) => this.onExit(run, x));
    run.startTimer = setTimeout(() => {
      if (!run.spoke) this.conclude(run, { worker: "failed", ticket: "blocked", feed: { kind: "error", text: `${worker.name} did not start within ${cfg.office.startTimeoutSec} seconds.` } });
    }, timeoutMs);
    run.proc.send(this.prompt(ticket, project, note));
  }

  private prompt(ticket: TicketRow, project: Config["office"]["projects"][number], note?: string): string {
    return [
      `Ticket #${ticket.id}: ${ticket.title}`,
      ticket.description,
      note ? `The owner sent this back with a note: ${note}` : "",
      `Project: ${project.name}${project.goal ? `\nGoal: ${project.goal}` : ""}`,
      `Work only inside ${project.folder}. When you are done, reply with a short report of what you did.`,
    ]
      .filter((s) => s !== "")
      .join("\n\n");
  }

  // ---- following a worker ----

  private onEvent(run: Run, ev: WorkerEvent): void {
    if (run.concluded) return;
    if (!run.spoke) {
      run.spoke = true;
      if (run.startTimer) clearTimeout(run.startTimer);
      this.d.store.patchWorker(run.workerId, { status: "running", detail: "" });
      this.changed();
    }
    switch (ev.kind) {
      case "init":
        this.d.store.patchWorker(run.workerId, { sessionId: ev.sessionId });
        break;
      case "text":
        this.feed(run.workerId, "text", ev.text.replace(/\s+/g, " ").trim());
        break;
      case "tool":
        this.d.store.patchWorker(run.workerId, { detail: clip(ev.summary, DETAIL_CHARS) });
        this.feed(run.workerId, "tool", ev.summary);
        this.changed();
        break;
      case "tool_result":
        if (!ev.ok) this.feed(run.workerId, "error", ev.text.replace(/\s+/g, " ").trim());
        break;
      case "quota":
        if (ev.quota.fiveHour) this.quota = { ...this.quota, fiveHour: ev.quota.fiveHour };
        if (ev.quota.sevenDay) this.quota = { ...this.quota, sevenDay: ev.quota.sevenDay };
        this.changed();
        this.pump();
        break;
      case "result":
        this.finish(run, ev);
        break;
    }
  }

  private finish(run: Run, ev: Extract<WorkerEvent, { kind: "result" }>): void {
    this.d.store.addTokens(run.workerId, ev.input + ev.output);
    this.d.usage({ source: "office", input: ev.input, output: ev.output });
    this.feed(run.workerId, "result", ev.text.replace(/\s+/g, " ").trim() || (ev.ok ? "Done." : "Stopped with an error."));
    run.answered++;
    if (run.answered < run.sent && ev.ok) return; // the owner said something meanwhile; its answer is still to come
    const worker = this.d.store.getWorker(run.workerId)!;
    const over = this.budgetReason(worker);
    if (over) this.conclude(run, { worker: "stopped", ticket: "blocked", feed: { kind: "error", text: over } });
    else this.conclude(run, { worker: "idle", ticket: ev.ok ? "review" : "blocked" });
  }

  private onExit(run: Run, x: WorkerExit): void {
    if (run.concluded) return;
    const text = x.notInstalled
      ? "Claude Code could not be started: it is not installed, or the program set under Model is wrong."
      : `The worker ended without a report (exit code ${x.code ?? "none"}).${x.stderr.trim() ? ` ${x.stderr.trim()}` : ""}`;
    this.conclude(run, { worker: "failed", ticket: "blocked", feed: { kind: "error", text } });
  }

  /** Ends a run: the worker's and the ticket's new states, the process and its questions, and whatever was waiting for a place. */
  private conclude(run: Run, o: { worker: WorkerStatus; ticket: TicketStatus | null; feed?: { kind: FeedKind; text: string } }): void {
    if (run.concluded) return;
    run.concluded = true;
    if (run.startTimer) clearTimeout(run.startTimer);
    this.runs.delete(run.workerId);
    this.d.store.patchWorker(run.workerId, { status: o.worker, detail: "", ticketId: null });
    if (o.ticket) this.d.store.patchTicket(run.ticketId, { status: o.ticket });
    if (o.feed) this.feed(run.workerId, o.feed.kind, o.feed.text);
    this.d.approvals.denyWhere((r) => (r.args as { workerId?: string } | null)?.workerId === run.workerId, "The worker was stopped.");
    try {
      run.proc?.kill();
    } catch {
      /* already gone */
    }
    void run.bridge.stop().catch(() => {});
    this.changed();
    this.pump();
  }

  // ---- the questions a worker asks ----

  private async onCall(run: Run, call: BridgeCall): Promise<void> {
    const answer = (v: object) => call.respond({ text: JSON.stringify(v) });
    if (call.name !== "approve") return call.respond({ text: `Error: there is no tool ${call.name}.`, isError: true });
    const a = (call.args ?? {}) as { tool_name?: unknown; input?: unknown };
    if (typeof a.tool_name !== "string" || !a.input || typeof a.input !== "object" || Array.isArray(a.input)) return answer({ behavior: "deny", message: "That question was not understood." });
    if (run.concluded) return answer({ behavior: "deny", message: "The worker was stopped." });
    const tool = a.tool_name;
    const input = a.input as Record<string, unknown>;
    const worker = this.d.store.getWorker(run.workerId);
    const project = worker && this.cfg.projects.find((p) => p.id === worker.projectId);
    if (!worker || !project) return answer({ behavior: "deny", message: "The project of this worker no longer exists." });

    const summary = summarizeToolCall(tool, input);
    const verdict = decideAction({ tool, input }, { folders: [project.folder, ...project.extraFolders], policy: this.cfg.policy, shellPatterns: this.d.config().destructivePatterns });
    if (verdict.verdict === "allow") {
      this.d.audit.log("agent", "office.approval", { worker: worker.id, tool, verdict: "allow", by: "policy" });
      return answer({ behavior: "allow", updatedInput: input });
    }
    if (verdict.verdict === "deny") {
      this.d.audit.log("agent", "office.approval", { worker: worker.id, tool, verdict: "deny", by: "policy" });
      this.feed(worker.id, "approval", `Refused: ${summary} (${verdict.reason})`);
      return answer({ behavior: "deny", message: verdict.reason });
    }

    run.pending++;
    this.d.store.patchWorker(worker.id, { status: "waiting", detail: clip(`Waiting: ${summary}`, DETAIL_CHARS) });
    this.feed(worker.id, "approval", `Asked: ${summary}`);
    this.changed();
    let outcome: { approved: boolean; reason?: string };
    try {
      outcome = await this.d.approvals.request({ tool: "office.action", args: { worker: worker.name, workerId: worker.id, summary: describeAction(tool, input) }, tier: verdict.danger ? "T3" : "T2", needsPin: verdict.danger }, this.d.emit);
    } catch {
      outcome = { approved: false, reason: "The question could not be put to the owner." };
    }
    run.pending--;
    if (!run.concluded && run.pending === 0 && this.d.store.getWorker(worker.id)?.status === "waiting") {
      this.d.store.patchWorker(worker.id, { status: "running", detail: "" });
      this.changed();
    }
    this.d.audit.log("owner", "office.approval", { worker: worker.id, tool, verdict: outcome.approved ? "allow" : "deny", by: "owner" });
    this.feed(worker.id, "approval", `${outcome.approved ? "Allowed" : "Not allowed"}: ${summary}`);
    return answer(outcome.approved ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: outcome.reason ?? "The owner said no." });
  }

  // ---- telling the screens ----

  private workerView(w: WorkerRow): OfficeWorkerView {
    const perWorker = this.cfg.budget.perWorkerTokens;
    return { id: w.id, name: w.name, roleId: w.roleId, projectId: w.projectId, status: w.status, ticketId: w.ticketId, detail: clip(w.detail, DETAIL_CHARS), tokens: w.tokens, budget: perWorker > 0 ? perWorker : null, startedAt: w.startedAt };
  }

  private feed(workerId: string, kind: FeedKind, text: string): void {
    const clipped = clip(text, FEED_CHARS);
    this.d.store.addEvent(workerId, { kind, text: clipped });
    this.d.emit({ type: "office.feed", workerId, at: Date.now(), kind, text: clipped });
  }

  /** The state goes to the screens at most once every 200 ms while things change quickly; the last state always follows. */
  private changed(): void {
    if (this.down) return; // the database may already be closed
    const since = Date.now() - this.lastEmit;
    if (since >= STATE_EVERY_MS) return this.flush();
    if (!this.emitTimer) this.emitTimer = setTimeout(() => this.flush(), STATE_EVERY_MS - since);
  }

  private flush(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.lastEmit = Date.now();
    this.d.emit(this.snapshot());
  }
}
