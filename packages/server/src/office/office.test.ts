import type { ServerMsg } from "@friend/protocol";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, sanitizeOffice } from "../config";
import { openDb } from "../db";
import type { BridgeAnswer, BridgeCall } from "../provider/claude-code/bridge";
import type { WorkerEvent } from "./events";
import { Office, type BridgeLike, type WorkerLike } from "./office";
import { OfficeStore } from "./store";

afterEach(() => vi.useRealTimers());

class FakeProc implements WorkerLike {
  alive = true;
  killed = 0;
  sent: string[] = [];
  exited: Promise<void>;
  private done!: () => void;
  constructor(public o: { command: string; args: string[]; cwd: string }, public onEvent: (e: WorkerEvent) => void, public onExit: (x: { code: number | null; stderr: string; notInstalled: boolean }) => void) {
    this.exited = new Promise((r) => (this.done = r));
  }
  send(t: string) {
    this.sent.push(t);
  }
  kill() {
    this.killed++;
    if (this.alive) {
      this.alive = false;
      this.done();
    }
  }
  emit(e: WorkerEvent) {
    this.onEvent(e);
  }
  exit(code: number | null, stderr = "", notInstalled = false) {
    this.alive = false;
    this.onExit({ code, stderr, notInstalled });
    this.done();
  }
}

class FakeBridge implements BridgeLike {
  url = "http://127.0.0.1:1/mcp";
  token = "tok";
  started = false;
  stopped = false;
  tools: unknown[] = [];
  private n = 0;
  constructor(public onCall: (c: BridgeCall) => void) {}
  async start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  setTools(t: unknown[]) {
    this.tools = t;
  }
  failPending() {}
  /** What Claude Code does: asks the approve tool, and waits for the answer. */
  ask(tool_name: string, input: Record<string, unknown>): Promise<{ behavior: string; message?: string; updatedInput?: unknown }> {
    return new Promise((resolve) => this.onCall({ id: `c${++this.n}`, name: "approve", args: { tool_name, input, tool_use_id: "u1" }, respond: (a: BridgeAnswer) => resolve(JSON.parse(a.text)) }));
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const initEv = (sessionId = "sess-1"): WorkerEvent => ({ kind: "init", sessionId, model: "m" });
const resultEv = (o: Partial<Extract<WorkerEvent, { kind: "result" }>> = {}): WorkerEvent => ({ kind: "result", ok: true, text: "Done.", turns: 2, durationMs: 10, input: 100, output: 50, denials: [], sessionId: "sess-1", ...o });
const quotaEv = (utilization: number, resetsAt: number): WorkerEvent => ({ kind: "quota", quota: { fiveHour: { utilization, resetsAt }, sevenDay: null } });

function make(over: Record<string, unknown> = {}, command?: string) {
  const dir = mkdtempSync(join(tmpdir(), "friend-office-"));
  const projectDir = join(dir, "site");
  mkdirSync(projectDir);
  const config = loadConfig(dir);
  if (command) config.claudeCode.command = command;
  config.office = sanitizeOffice({
    enabled: true,
    maxConcurrent: 2,
    roles: [
      { id: "scribe", title: "Scribe", instructions: "Write.", model: "", permission: "default" },
      { id: "coder", title: "Coder", instructions: "Code.", model: "fast", permission: "acceptEdits" },
    ],
    projects: [{ id: "site", name: "Site", folder: projectDir, goal: "Ship it", extraFolders: [] }],
    policy: { allowTools: ["Read", "Write"], denyCommands: ["git\\s+push"] },
    ...over,
  });
  const store = new OfficeStore(openDb(dir));
  const procs: FakeProc[] = [];
  const bridges: FakeBridge[] = [];
  const emitted: ServerMsg[] = [];
  const usage = vi.fn();
  const notify = vi.fn();
  const audit = { log: vi.fn() };
  const resolvers: { req: { tool: string; args: any; tier: string; needsPin: boolean }; resolve: (o: { approved: boolean; reason?: string }) => void }[] = [];
  const approvals = {
    request: vi.fn((req: any) => new Promise<{ approved: boolean; reason?: string }>((resolve) => resolvers.push({ req, resolve }))),
    denyWhere: vi.fn((match: (r: any) => boolean, reason: string) => {
      let n = 0;
      for (const r of resolvers) if (match(r.req)) (r.resolve({ approved: false, reason }), n++);
      return n;
    }),
  };
  const office = new Office({
    config: () => config,
    store,
    approvals: approvals as never,
    audit,
    usage,
    notify,
    emit: (m) => emitted.push(m),
    spawn: (o, onEvent, onExit) => {
      const p = new FakeProc(o, onEvent, onExit);
      procs.push(p);
      return p;
    },
    bridge: (onCall) => {
      const b = new FakeBridge(onCall);
      bridges.push(b);
      return b;
    },
    dataDir: dir,
  });
  const hire = (role = "scribe", name?: string) => {
    const r = office.hire({ role, project: "site", ...(name ? { name } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.worker;
  };
  const feeds = () => emitted.filter((m): m is Extract<ServerMsg, { type: "office.feed" }> => m.type === "office.feed");
  const alerts = () => emitted.filter((m) => m.type === "alert");
  return { dir, projectDir, config, store, office, notify, procs, bridges, emitted, usage, audit, approvals, resolvers, hire, feeds, alerts };
}

describe("hiring", () => {
  it("refuses while the Office is off, and says where to switch it on", () => {
    const t = make({ enabled: false });
    expect(t.office.hire({ role: "scribe", project: "site" })).toEqual({ ok: false, error: "The Office is switched off in Settings." });
  });

  it("names the roles and projects that exist when the one asked for does not", () => {
    const t = make();
    const r1 = t.office.hire({ role: "nope", project: "site" });
    expect(r1).toMatchObject({ ok: false });
    expect((r1 as { error: string }).error).toMatch(/nope/);
    expect((r1 as { error: string }).error).toMatch(/scribe/);
    expect((r1 as { error: string }).error).toMatch(/coder/);
    const r2 = t.office.hire({ role: "scribe", project: "zzz" });
    expect((r2 as { error: string }).error).toMatch(/site/);
  });

  it("needs the project folder to exist", () => {
    const t = make({ projects: [{ id: "gone", name: "Gone", folder: "C:\\definitely\\not\\here", goal: "", extraFolders: [] }] });
    const r = t.office.hire({ role: "scribe", project: "gone" });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/folder/i);
  });

  it("gives each worker a name from its role, unique in any letter case, or keeps the name it was given", () => {
    const t = make();
    expect(t.hire("scribe").name).toBe("Scribe 1");
    expect(t.hire("scribe").name).toBe("Scribe 2");
    expect(t.hire("coder", "Ada").name).toBe("Ada");
    expect(t.office.hire({ role: "coder", project: "site", name: "ada" })).toMatchObject({ ok: false });
  });

  it("is written to the audit log and shown on the screen", () => {
    const t = make();
    t.hire("scribe");
    expect(t.audit.log).toHaveBeenCalledWith("agent", "office.hire", expect.objectContaining({ role: "scribe" }));
    expect(t.office.snapshot()).toMatchObject({ type: "office.state", enabled: true, workers: [expect.objectContaining({ name: "Scribe 1", status: "idle" })] });
  });
});

describe("a run", () => {
  it("starts the program in the project folder with the ticket as its first message, and follows it to the end", async () => {
    const t = make();
    const w = t.hire("scribe");
    const r = t.office.assign({ worker: w.id, title: "Fix login", description: "Make it work" });
    expect(r).toMatchObject({ ok: true, queued: false });
    await settle();
    expect(t.procs).toHaveLength(1);
    const p = t.procs[0]!;
    expect(p.o.cwd).toBe(t.projectDir);
    expect(p.o.command).toBe("claude");
    expect(p.o.args).toContain("--permission-prompt-tool");
    expect(p.o.args).not.toContain("--allowedTools");
    expect(p.sent[0]).toMatch(/Fix login/);
    expect(p.sent[0]).toMatch(/Make it work/);
    expect(p.sent[0]).toMatch(/Ship it/);
    expect(t.bridges[0]!.started).toBe(true);
    expect(JSON.parse(readFileSync(p.o.args[p.o.args.indexOf("--mcp-config") + 1]!, "utf8")).mcpServers.office).toMatchObject({ type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer tok" } });
    expect(t.store.getWorker(w.id)).toMatchObject({ status: "starting", ticketId: (r as { ticket: { id: number } }).ticket.id });
    expect(t.store.getTicket((r as { ticket: { id: number } }).ticket.id)!.status).toBe("doing");

    p.emit(initEv("sess-1"));
    expect(t.store.getWorker(w.id)).toMatchObject({ status: "running", sessionId: "sess-1" });
    p.emit({ kind: "tool", id: "t1", name: "Write", summary: "Write a.txt" });
    expect(t.store.getWorker(w.id)!.detail).toBe("Write a.txt");
    expect(t.feeds().at(-1)).toMatchObject({ workerId: w.id, kind: "tool", text: "Write a.txt" });
    p.emit(resultEv());
    expect(t.store.getWorker(w.id)).toMatchObject({ status: "idle", tokens: 150, detail: "" });
    expect(t.store.getTicket((r as { ticket: { id: number } }).ticket.id)!.status).toBe("review");
    expect(t.usage).toHaveBeenCalledWith({ source: "office", input: 100, output: 50 });
    expect(p.alive).toBe(false); // the process is ended after the result; the next ticket resumes the session
    await settle();
    expect(t.bridges[0]!.stopped).toBe(true);
  });

  it("resumes the worker's session for the next ticket, with the role's own model when it has one", async () => {
    const t = make();
    const w = t.hire("coder", "Ada");
    t.office.assign({ worker: w.id, title: "One" });
    await settle();
    t.procs[0]!.emit(initEv("sess-9"));
    t.procs[0]!.emit(resultEv({ sessionId: "sess-9" }));
    t.office.assign({ worker: "ada", title: "Two" });
    await settle();
    const args = t.procs[1]!.o.args;
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-9");
    expect(args[args.indexOf("--model") + 1]).toBe("fast");
  });

  it("uses the model chosen under Model when the role names none", async () => {
    const t = make();
    t.config.claudeCode.model = "sonnet";
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "One" });
    await settle();
    expect(t.procs[0]!.o.args[t.procs[0]!.o.args.indexOf("--model") + 1]).toBe("sonnet");
  });

  it("runs only as many at once as the owner allowed, and the rest wait in order", async () => {
    const t = make({ maxConcurrent: 1 });
    const [a, b, c] = [t.hire("scribe"), t.hire("scribe"), t.hire("coder")];
    expect(t.office.assign({ worker: a.id, title: "A" })).toMatchObject({ queued: false });
    expect(t.office.assign({ worker: b.id, title: "B" })).toMatchObject({ queued: true });
    expect(t.office.assign({ worker: c.id, title: "C" })).toMatchObject({ queued: true });
    await settle();
    expect(t.procs).toHaveLength(1);
    t.procs[0]!.emit(resultEv());
    await settle();
    expect(t.procs).toHaveLength(2);
    expect(t.procs[1]!.sent[0]).toMatch(/B/);
    t.procs[1]!.emit(resultEv());
    await settle();
    expect(t.procs[2]!.sent[0]).toMatch(/C/);
  });

  it("queues a second ticket for a worker that is already busy", async () => {
    const t = make();
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "First" });
    expect(t.office.assign({ worker: w.id, title: "Second" })).toMatchObject({ ok: true, queued: true });
    await settle();
    expect(t.procs).toHaveLength(1);
    t.procs[0]!.emit(resultEv());
    await settle();
    expect(t.procs).toHaveLength(2);
    expect(t.procs[1]!.sent[0]).toMatch(/Second/);
  });

  it("refuses a ticket for a worker that does not exist, and while the Office is off", () => {
    const t = make();
    expect(t.office.assign({ worker: "nobody", title: "x" })).toMatchObject({ ok: false });
    const off = make({ enabled: false });
    expect(off.office.assign({ worker: "x", title: "x" })).toEqual({ ok: false, error: "The Office is switched off in Settings." });
  });

  it("marks the worker failed when the program ends in an error, and clips what it said to 200 characters", async () => {
    const t = make();
    const w = t.hire("scribe");
    const r = t.office.assign({ worker: w.id, title: "x" }) as { ticket: { id: number } };
    await settle();
    t.procs[0]!.exit(1, "boom ".repeat(200));
    expect(t.store.getWorker(w.id)!.status).toBe("failed");
    expect(t.store.getTicket(r.ticket.id)!.status).toBe("blocked");
    expect(t.feeds().at(-1)).toMatchObject({ kind: "error" });
    expect(t.feeds().at(-1)!.text.length).toBeLessThanOrEqual(200);
    await settle();
    expect(t.bridges[0]!.stopped).toBe(true);
  });

  it("says plainly when Claude Code is not installed", async () => {
    const t = make();
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "x" });
    await settle();
    t.procs[0]!.exit(null, "", true);
    expect(t.feeds().at(-1)!.text).toMatch(/not installed/i);
  });

  it("stops a worker that says nothing for the start-up time the owner set", async () => {
    vi.useFakeTimers();
    const t = make({ startTimeoutSec: 30 });
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "x" });
    await settle();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(t.procs[0]!.alive).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.procs[0]!.alive).toBe(false);
    expect(t.store.getWorker(w.id)!.status).toBe("failed");
    expect(t.feeds().at(-1)!.text).toMatch(/30 seconds/);
  });

  it("does not start the timer's failure once the worker has spoken", async () => {
    vi.useFakeTimers();
    const t = make({ startTimeoutSec: 30 });
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "x" });
    await settle();
    t.procs[0]!.emit(initEv());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.procs[0]!.alive).toBe(true);
  });
});

describe("what a worker may do", () => {
  async function running(over: Record<string, unknown> = {}) {
    const t = make(over);
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "x" });
    await settle();
    t.procs[0]!.emit(initEv());
    return { t, w, bridge: t.bridges[0]!, proc: t.procs[0]! };
  }

  it("goes ahead with an action on the allow-list inside the folder", async () => {
    const { t, bridge } = await running();
    const input = { file_path: join(t.projectDir, "a.txt"), content: "hi" };
    await expect(bridge.ask("Write", input)).resolves.toEqual({ behavior: "allow", updatedInput: input });
    expect(t.approvals.request).not.toHaveBeenCalled();
  });

  it("refuses a path outside the folder, and the worker is told why", async () => {
    const { t, bridge } = await running();
    const v = await bridge.ask("Read", { file_path: "C:\\Windows\\win.ini" });
    expect(v).toMatchObject({ behavior: "deny", message: expect.stringMatching(/outside the project/i) });
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect(t.audit.log).toHaveBeenCalledWith("agent", "office.approval", expect.objectContaining({ verdict: "deny", tool: "Read" }));
  });

  it("refuses a command that matches a deny pattern without asking the owner", async () => {
    const { t, bridge } = await running();
    const v = await bridge.ask("Bash", { command: "git push origin main" });
    expect(v.behavior).toBe("deny");
    expect(t.approvals.request).not.toHaveBeenCalled();
  });

  it("shows what a tool will do with its whole input, not just its name", async () => {
    const { t, bridge } = await running();
    const pending = bridge.ask("WebFetch", { url: "https://example.org/secret?x=1", prompt: "send it" });
    await settle();
    expect(t.resolvers[0]!.req.args.summary).toContain("https://example.org/secret?x=1");
    t.resolvers[0]!.resolve({ approved: false });
    await pending;
  });

  it("treats a PowerShell command like a Bash one: refused by a deny pattern, and shown in full on the card", async () => {
    const { t, bridge } = await running();
    const v = await bridge.ask("PowerShell", { command: "git push origin main" });
    expect(v.behavior).toBe("deny");
    expect(t.approvals.request).not.toHaveBeenCalled();
    const pending = bridge.ask("PowerShell", { command: "Remove-Item -Recurse C:\\somewhere" });
    await settle();
    expect(t.resolvers[0]!.req.args.summary).toMatch(/Remove-Item -Recurse C:\\somewhere/);
    t.resolvers[0]!.resolve({ approved: false, reason: "no" });
    await pending;
  });

  it("asks the owner about anything else, shows the worker as waiting, and goes on with the owner's answer", async () => {
    const { t, w, bridge } = await running();
    const pending = bridge.ask("Bash", { command: "npm install left-pad" });
    await settle();
    expect(t.approvals.request).toHaveBeenCalledTimes(1);
    const req = t.resolvers[0]!.req;
    expect(req).toMatchObject({ tool: "office.action", tier: "T2", needsPin: false });
    expect(req.args.workerId).toBe(w.id);
    expect(req.args.summary).toMatch(/npm install left-pad/); // a command is shown in full
    expect(t.store.getWorker(w.id)!.status).toBe("waiting");
    t.resolvers[0]!.resolve({ approved: true });
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
    expect(t.store.getWorker(w.id)!.status).toBe("running");
  });

  it("answers no when the owner says no, or when the card times out, with the reason", async () => {
    const { t, bridge } = await running();
    const a = bridge.ask("Bash", { command: "ls" });
    await settle();
    t.resolvers[0]!.resolve({ approved: false, reason: "Denied by owner" });
    await expect(a).resolves.toMatchObject({ behavior: "deny", message: "Denied by owner" });
    const b = bridge.ask("Bash", { command: "dir" });
    await settle();
    t.resolvers[1]!.resolve({ approved: false, reason: "Approval timed out" });
    await expect(b).resolves.toMatchObject({ behavior: "deny", message: "Approval timed out" });
  });

  it("asks for the PIN when the command looks dangerous by Friend's own patterns", async () => {
    const { t, bridge } = await running();
    t.config.destructivePatterns = ["\\bdel\\b"];
    void bridge.ask("Bash", { command: "del x.txt" });
    await settle();
    expect(t.resolvers[0]!.req).toMatchObject({ tier: "T3", needsPin: true });
  });

  it("denies a call that is not shaped like a question about a tool", async () => {
    const { bridge } = await running();
    const v = await new Promise<{ behavior: string }>((resolve) => bridge.onCall({ id: "x", name: "approve", args: { nonsense: true }, respond: (a) => resolve(JSON.parse(a.text)) }));
    expect(v.behavior).toBe("deny");
    const w = await new Promise<BridgeAnswer>((resolve) => bridge.onCall({ id: "y", name: "something-else", args: {}, respond: resolve }));
    expect(w.isError).toBe(true);
  });

  it("shows what it refused and what it asked in the feed", async () => {
    const { t, bridge } = await running();
    await bridge.ask("Read", { file_path: "C:\\x" });
    expect(t.feeds().some((f) => f.kind === "approval" && /refus/i.test(f.text))).toBe(true);
  });
});

describe("the subscription window", () => {
  it("makes new runs wait while the window is as full as the owner set, tells them once when it resumes, and starts them when it drops", async () => {
    const t = make();
    const a = t.hire("scribe");
    const b = t.hire("coder");
    const reset = Math.floor(Date.now() / 1000) + 3600;
    t.office.assign({ worker: a.id, title: "A" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(quotaEv(0.95, reset));
    expect(t.office.snapshot()).toMatchObject({ quota: { fiveHour: { utilization: 0.95 } } });
    expect(t.office.assign({ worker: b.id, title: "B" })).toMatchObject({ queued: true });
    await settle();
    expect(t.procs).toHaveLength(1);
    expect(t.store.getWorker(b.id)!.status).toBe("paused");
    expect(t.alerts()).toHaveLength(1);
    expect((t.alerts()[0] as { text: string }).text).toMatch(/95%/);
    t.office.assign({ worker: b.id, title: "B2" }); // a second wait does not repeat the alert
    expect(t.alerts()).toHaveLength(1);
    t.procs[0]!.emit(quotaEv(0.5, reset));
    await settle();
    expect(t.procs).toHaveLength(2);
    expect(t.store.getWorker(b.id)!.status).not.toBe("paused");
  });

  it("starts the waiting run when the window resets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const t = make();
    const a = t.hire("scribe");
    const b = t.hire("coder");
    const reset = Math.floor(Date.now() / 1000) + 600;
    t.office.assign({ worker: a.id, title: "A" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(quotaEv(0.97, reset));
    t.procs[0]!.emit(resultEv());
    t.office.assign({ worker: b.id, title: "B" });
    await settle();
    expect(t.procs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(601_000);
    await settle();
    expect(t.procs).toHaveLength(2);
  });

  it("never waits when the owner set the pause to 0", async () => {
    const t = make({ pauseAtWindow: 0 });
    const a = t.hire("scribe");
    t.office.assign({ worker: a.id, title: "A" });
    await settle();
    t.procs[0]!.emit(quotaEv(0.99, Math.floor(Date.now() / 1000) + 3600));
    t.procs[0]!.emit(resultEv());
    const b = t.hire("coder");
    t.office.assign({ worker: b.id, title: "B" });
    await settle();
    expect(t.procs).toHaveLength(2);
  });

  it("does not stop runs that are already going", async () => {
    const t = make();
    const a = t.hire("scribe");
    t.office.assign({ worker: a.id, title: "A" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(quotaEv(0.99, Math.floor(Date.now() / 1000) + 3600));
    expect(t.procs[0]!.alive).toBe(true);
  });
});

describe("budgets", () => {
  it("stops a worker that has used its tokens, blocks the ticket, and says so", async () => {
    const t = make({ budget: { perWorkerTokens: 100, totalTokens: 0 } });
    const w = t.hire("scribe");
    const r = t.office.assign({ worker: w.id, title: "x" }) as { ticket: { id: number } };
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(resultEv({ input: 100, output: 50 }));
    expect(t.store.getWorker(w.id)!.status).toBe("stopped");
    expect(t.store.getTicket(r.ticket.id)!.status).toBe("blocked");
    expect(t.feeds().some((f) => /budget/i.test(f.text))).toBe(true);
    expect(t.office.snapshot()).toMatchObject({ workers: [expect.objectContaining({ budget: 100 })] });
  });

  it("does not start a run for a worker already over its budget", async () => {
    const t = make({ budget: { perWorkerTokens: 100, totalTokens: 0 } });
    const w = t.hire("scribe");
    t.store.addTokens(w.id, 500);
    const r = t.office.assign({ worker: w.id, title: "x" }) as { ticket: { id: number } };
    await settle();
    expect(t.procs).toHaveLength(0);
    expect(t.store.getTicket(r.ticket.id)!.status).toBe("blocked");
  });

  it("holds all workers to the total", async () => {
    const t = make({ budget: { perWorkerTokens: 0, totalTokens: 200 } });
    const a = t.hire("scribe");
    const b = t.hire("coder");
    t.office.assign({ worker: a.id, title: "A" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(resultEv({ input: 150, output: 100 }));
    const r = t.office.assign({ worker: b.id, title: "B" }) as { ticket: { id: number } };
    await settle();
    expect(t.procs).toHaveLength(1);
    expect(t.store.getTicket(r.ticket.id)!.status).toBe("blocked");
  });
});

describe("stopping", () => {
  it("ends one worker, answers its waiting questions with no, takes their cards away, and puts its ticket back", async () => {
    const t = make();
    const a = t.hire("scribe");
    const b = t.hire("coder");
    const ra = t.office.assign({ worker: a.id, title: "A" }) as { ticket: { id: number } };
    t.office.assign({ worker: b.id, title: "B" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[1]!.emit(initEv());
    const pending = t.bridges[0]!.ask("Bash", { command: "npm test" });
    await settle();
    expect(t.office.stop(a.id)).toEqual({ stopped: 1 });
    expect(t.approvals.denyWhere).toHaveBeenCalled();
    await expect(pending).resolves.toMatchObject({ behavior: "deny" });
    expect(t.procs[0]!.alive).toBe(false);
    expect(t.procs[1]!.alive).toBe(true);
    expect(t.store.getWorker(a.id)!.status).toBe("stopped");
    expect(t.store.getTicket(ra.ticket.id)!.status).toBe("todo");
    await settle();
    expect(t.bridges[0]!.stopped).toBe(true);
  });

  it("ends every worker when none is named, and leaves queued tickets as todo", async () => {
    const t = make({ maxConcurrent: 1 });
    const a = t.hire("scribe");
    const b = t.hire("coder");
    t.office.assign({ worker: a.id, title: "A" });
    const rb = t.office.assign({ worker: b.id, title: "B" }) as { ticket: { id: number } };
    await settle();
    expect(t.office.stop()).toEqual({ stopped: 1 });
    await settle();
    expect(t.procs).toHaveLength(1); // the queued ticket did not start behind the stop
    expect(t.store.getTicket(rb.ticket.id)!.status).toBe("todo");
  });

  it("does nothing, harmlessly, for a worker that is not running", () => {
    const t = make();
    const w = t.hire("scribe");
    expect(t.office.stop(w.id)).toEqual({ stopped: 0 });
    expect(t.office.stop("nobody")).toEqual({ stopped: 0 });
  });

  it("leaves nothing running when Friend shuts down", async () => {
    const t = make();
    const a = t.hire("scribe");
    const b = t.hire("coder");
    t.office.assign({ worker: a.id, title: "A" });
    t.office.assign({ worker: b.id, title: "B" });
    await settle();
    await t.office.shutdown();
    expect(t.procs.every((p) => !p.alive)).toBe(true);
    expect(t.bridges.every((x) => x.stopped)).toBe(true);
  });

  it("has nothing left running after a crash: workers that were running become stopped at start", () => {
    const t = make();
    const w = t.hire("scribe");
    t.store.patchWorker(w.id, { status: "running" });
    new Office({ config: () => t.config, store: t.store, approvals: t.approvals as never, audit: t.audit, usage: t.usage, emit: () => {}, dataDir: t.dir });
    expect(t.store.getWorker(w.id)!.status).toBe("stopped");
  });
});

describe("reviewing and talking", () => {
  it("accepts a ticket that is in review, or sends it back with a note and runs it again", async () => {
    const t = make();
    const w = t.hire("scribe");
    const r = t.office.assign({ worker: w.id, title: "x", description: "d" }) as { ticket: { id: number } };
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(resultEv());
    expect(t.office.review(r.ticket.id, true)).toEqual({ ok: true });
    expect(t.store.getTicket(r.ticket.id)!.status).toBe("done");
    const r2 = t.office.assign({ worker: w.id, title: "y" }) as { ticket: { id: number } };
    await settle();
    t.procs[1]!.emit(initEv());
    t.procs[1]!.emit(resultEv());
    expect(t.office.review(r2.ticket.id, false, "Add tests")).toEqual({ ok: true });
    await settle();
    expect(t.procs).toHaveLength(3);
    expect(t.procs[2]!.sent[0]).toMatch(/Add tests/);
    expect(t.office.review(9999, true)).toMatchObject({ ok: false });
  });

  it("will not review a ticket that is not in review", () => {
    const t = make();
    const w = t.hire("scribe");
    const r = t.office.assign({ worker: w.id, title: "x" }) as { ticket: { id: number } };
    expect(t.office.review(r.ticket.id, true)).toMatchObject({ ok: false });
  });

  it("tells Friend when a ticket is finished, with the worker's report, so Friend can carry on", async () => {
    const t = make();
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "Write notes" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(resultEv({ text: "Wrote notes.md" }));
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ worker: w.name, ticketId: 1, title: "Write notes", status: "review", report: "Wrote notes.md" }));
  });

  it("tells Friend when a ticket ends blocked, and not when the owner stops it", async () => {
    const t = make();
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "One" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.exit(1, "boom");
    expect(t.notify).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 1, status: "blocked" }));
    t.notify.mockClear();
    t.office.assign({ worker: w.id, title: "Two" });
    await settle();
    t.office.stop(w.id, "owner");
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("keeps quiet when the owner switched off telling Friend", async () => {
    const t = make({ notifyFriend: false });
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "x" });
    await settle();
    t.procs[0]!.emit(initEv());
    t.procs[0]!.emit(resultEv());
    expect(t.notify).not.toHaveBeenCalled();
  });

  it("passes what the owner says to a running worker, and starts a run for one that is idle", async () => {
    const t = make();
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "x" });
    await settle();
    t.procs[0]!.emit(initEv());
    expect(t.office.say(w.id, "Use tabs")).toEqual({ ok: true });
    expect(t.procs[0]!.sent.at(-1)).toBe("Use tabs");
    t.procs[0]!.emit(resultEv()); // the answer to the ticket
    expect(t.procs[0]!.killed).toBe(0); // the owner's message is still being answered
    t.procs[0]!.emit(resultEv()); // the answer to the owner's message
    expect(t.procs[0]!.killed).toBeGreaterThan(0);
    expect(t.office.say("scribe 1", "One more thing")).toEqual({ ok: true });
    await settle();
    expect(t.procs).toHaveLength(2);
    expect(t.procs[1]!.sent[0]).toMatch(/One more thing/);
    expect(t.office.say("nobody", "hi")).toMatchObject({ ok: false });
  });
});

describe("what the screens are told", () => {
  it("never carries a ticket's description", () => {
    const t = make();
    const w = t.hire("scribe");
    t.office.assign({ worker: w.id, title: "Visible title", description: "SECRET DESCRIPTION" });
    expect(JSON.stringify(t.office.status())).not.toContain("SECRET DESCRIPTION");
    expect(JSON.stringify(t.office.snapshot())).not.toContain("SECRET DESCRIPTION");
    expect(JSON.stringify(t.office.status())).toContain("Visible title");
  });

  it("sends the state at most once every 200 ms while things change quickly, and the last state after that", async () => {
    vi.useFakeTimers();
    const t = make();
    const states = () => t.emitted.filter((m) => m.type === "office.state");
    t.hire("scribe");
    const first = states().length;
    expect(first).toBe(1);
    t.hire("scribe");
    t.hire("scribe");
    t.hire("scribe");
    expect(states().length).toBe(first); // held back, not lost
    await vi.advanceTimersByTimeAsync(250);
    expect(states().length).toBe(first + 1);
    expect((states().at(-1) as { workers: unknown[] }).workers).toHaveLength(4);
  });
});
