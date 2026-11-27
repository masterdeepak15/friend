import type { Audit } from "../audit";
import { checkPcCall } from "./guard";
import type { PcHub, PcExecResult } from "./hub";
import type { PcStore, Pc } from "./store";

export interface PcToolResult {
  text: string;
  isError: boolean;
  image?: { mime: string; data: string };
}

/** Asks the owner (a card naming the PC) about something the PC found critical. */
export type AskOwner = (reason: string, detail: string) => Promise<boolean>;

export interface PreparedPc {
  pcName: string;
  /** T1 goes straight through; T2 makes the loop ask the owner first. */
  tier: "T1" | "T2";
  run(ask: AskOwner, signal: AbortSignal): Promise<PcToolResult>;
}

export interface PcToolsDeps {
  hub: PcHub;
  store: PcStore;
  audit: Audit;
  /** The owner's own patterns for shell commands that ask. */
  extraPatterns: () => string[];
  /** Whether the plugin is installed and switched on. */
  enabled?: () => boolean;
}

/** What these tools type or put in: never written to the audit trail, only how long it was. */
const SECRET_TEXT = new Set(["pc.type", "pc.clipboard", "pc.term.send", "pc.multi_edit"]);

const ago = (t: number): string => {
  if (!t) return "never";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

function timeoutFor(tool: string, a: Record<string, unknown>): number {
  const n = (k: string, d: number): number => (typeof a[k] === "number" ? (a[k] as number) : d);
  switch (tool) {
    case "pc.shell":
      return (n("timeoutSeconds", 60) + 10) * 1000;
    case "pc.wait":
      return (n("seconds", 1) + 10) * 1000;
    case "pc.wait_for":
    case "pc.term.wait":
      return (n("timeout", tool === "pc.wait_for" ? 10 : 60) + 10) * 1000;
    case "pc.snapshot":
    case "pc.screenshot":
      return 45_000;
    default:
      return 30_000;
  }
}

/** What goes in the audit trail about a call: the PC, the tool, what it targeted, and only the length of anything typed. */
function summary(tool: string, a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (k === "pc") continue;
    if (SECRET_TEXT.has(tool) && (k === "text" || k === "edits")) out.chars = k === "edits" && Array.isArray(v) ? JSON.stringify(v).length : String(v).length;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 10);
  }
  return out;
}

/** The `pc.*` tools of the assistant: choose the PC, check what it may do, send the call, and bring back the answer. */
export class PcTools {
  constructor(private readonly deps: PcToolsDeps) {}

  prepare(name: string, args: unknown): PreparedPc | { error: string } {
    const { hub, store } = this.deps;
    const a = (args ?? {}) as Record<string, unknown>;
    if (this.deps.enabled && !this.deps.enabled()) return { error: "The Windows PCs plugin is not switched on. Ask the owner to install it and switch it on in Plugins (Windows PCs)." };
    if (name === "pc.list") return { pcName: "", tier: "T1", run: async () => ({ text: this.list(), isError: false }) };

    const which = hub.resolve(typeof a.pc === "string" ? a.pc : undefined);
    if ("ask" in which) return { error: which.ask };
    if ("error" in which) return { error: which.error };
    const pc = store.get(which.pcId);
    if (!pc) return { error: "There is no such PC." };

    const verdict = checkPcCall(name, a, pc.permissions, { lease: hub.leaseActive(pc.id) }, this.deps.extraPatterns());
    if (verdict.decision === "deny") {
      this.deps.audit.log("agent", "pc.refused", { pc: pc.name, tool: name, reason: verdict.reason, ...summary(name, a) });
      return { error: verdict.reason ?? "Not allowed on this PC." };
    }
    return { pcName: pc.name, tier: verdict.decision === "ask" ? "T2" : "T1", run: (ask, signal) => this.run(pc, name, a, ask, signal) };
  }

  private list(): string {
    const { hub, store } = this.deps;
    const all = store.list().filter((p) => !p.revoked);
    if (all.length === 0) return "There are no PCs yet. The owner adds one in Plugins, Windows PCs.";
    return all
      .map((p) => {
        const on = hub.isOnline(p.id);
        const s = hub.statusOf(p.id) ?? p.status;
        const lease = hub.leaseInfo(p.id);
        return `${p.name}: ${on ? "online" : "offline"}${on && s ? `, ${s.state}` : ""}${s?.task ? `, task: ${s.task}` : ""}${lease ? (lease.paused ? ", control session paused" : ", control session running") : ""}${on ? "" : `, last seen ${ago(p.lastSeen)}`} (${p.os || "Windows"}${p.host ? `, ${p.host}` : ""})`;
      })
      .join("\n");
  }

  private async run(pc: Pc, name: string, a: Record<string, unknown>, ask: AskOwner, signal: AbortSignal): Promise<PcToolResult> {
    const { hub, audit } = this.deps;
    const started = Date.now();
    let result: PcToolResult;
    try {
      if (name === "pc.control") result = this.control(pc, a);
      else result = await this.remote(pc, name, a, ask, signal);
    } catch (e) {
      result = { text: `Error: ${(e as Error).message}`, isError: true };
    }
    audit.log("agent", "pc.call", { pc: pc.name, tool: name, ok: !result.isError, ms: Date.now() - started, lease: hub.leaseActive(pc.id), ...summary(name, a) });
    return result;
  }

  private control(pc: Pc, a: Record<string, unknown>): PcToolResult {
    const { hub } = this.deps;
    const action = String(a.action);
    if (action === "start") {
      const r = hub.startLease(pc.id, typeof a.minutes === "number" ? a.minutes : undefined);
      return r.ok ? { text: `The control session on ${pc.name} started${typeof a.minutes === "number" ? ` for ${a.minutes} minutes` : ""}. The PC shows a border and a banner while it runs, and the owner's own mouse or keyboard use pauses it. Look with pc.snapshot first.`, isError: false } : { text: `Error: ${r.error}`, isError: true };
    }
    if (action === "stop") {
      hub.endLease(pc.id);
      return { text: `The control session on ${pc.name} ended.`, isError: false };
    }
    const lease = hub.leaseInfo(pc.id);
    const s = hub.statusOf(pc.id);
    return { text: `${pc.name}: ${lease ? (lease.paused ? "the control session is paused (the person at the PC used the mouse or keyboard); start it again with pc.control start" : `a control session is running${lease.until ? ` until ${new Date(lease.until).toLocaleTimeString()}` : ""}`) : "no control session"}${s ? `; status ${s.state}${s.task ? `, task: ${s.task}` : ""}${s.last ? `, last: ${s.last}` : ""}` : ""}.`, isError: false };
  }

  private async remote(pc: Pc, name: string, a: Record<string, unknown>, ask: AskOwner, signal: AbortSignal): Promise<PcToolResult> {
    const { hub } = this.deps;
    const { pc: _name, ...args } = a;
    const send = (approved: boolean): Promise<PcExecResult> => hub.exec(pc.id, name, args, timeoutFor(name, a), { permissions: pc.permissions, ...(approved ? { approved: true } : {}) });
    const aborted = new Promise<PcExecResult>((resolve) => signal.addEventListener("abort", () => resolve({ ok: false, error: "Stopped." }), { once: true }));
    let r = await Promise.race([send(false), aborted]);
    if (!r.ok && "needsApproval" in r) {
      const yes = await ask(r.needsApproval.reason, r.needsApproval.detail);
      if (!yes) return { text: `Error: The owner did not approve this (${r.needsApproval.reason}).`, isError: true };
      r = await Promise.race([send(true), aborted]);
    }
    if (!r.ok) return { text: `Error: ${r.error}`, isError: true };
    return { text: r.output, isError: false, ...(r.image ? { image: r.image } : {}) };
  }
}
