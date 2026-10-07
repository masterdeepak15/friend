import { describeCall, type ApprovalRespond, type PendingApproval, type ServerMsg, type Tier } from "@friend/protocol";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit";
import { LockoutError, type Auth } from "./auth";
import type { Db } from "./db";
import { isSimpleCommand } from "./policy/classify";
import type { PolicyEngine } from "./policy/engine";

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  tier: Tier;
  needsPin: boolean;
  /** Name of the device the call will run on, shown on the approval card. */
  device?: string | null;
}
export interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
}

interface Entry {
  info: PendingApproval;
  req: ApprovalRequest;
  emit: (m: ServerMsg) => void;
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

interface Deps {
  auth: Auth;
  policy: PolicyEngine;
  audit: Audit;
  db: Db;
}

export class Approvals {
  private entries = new Map<string, Entry>();

  constructor(private deps: Deps, private timeoutMs = 120_000) {}

  request(req: ApprovalRequest, emit: (m: ServerMsg) => void): Promise<ApprovalOutcome> {
    const id = randomUUID();
    const info: PendingApproval = {
      id,
      tool: req.tool,
      summary: describeCall(req.tool, req.args, req.device ?? undefined),
      tier: req.tier,
      needsPin: req.needsPin,
    };
    this.deps.db
      .prepare("insert into approvals (id, tool, summary, tier) values (?, ?, ?, ?)")
      .run(id, info.tool, info.summary, info.tier);
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, { approved: false, reason: "Approval timed out" }, "timeout"), this.timeoutMs);
      this.entries.set(id, { info, req, emit, resolve, timer });
      emit({ type: "approval.request", ...info });
    });
  }

  pending(): PendingApproval | null {
    const first = this.entries.values().next();
    return first.done ? null : first.value.info;
  }

  async respond(msg: Pick<ApprovalRespond, "id" | "decision" | "pin">, ip: string): Promise<void> {
    const entry = this.entries.get(msg.id);
    if (!entry) {
      this.deps.audit.log("owner", "approval.ignored", { id: msg.id, ip });
      return;
    }
    if (msg.decision === "deny") return this.finish(msg.id, { approved: false, reason: "Denied by owner" }, "deny");

    if (entry.req.needsPin) {
      if (!msg.pin) {
        entry.emit({ type: "alert", level: "warn", text: "PIN required to approve this action" });
        return;
      }
      let ok = false;
      try {
        ok = await this.deps.auth.verifyPin(msg.pin, ip);
      } catch (e) {
        if (e instanceof LockoutError) {
          entry.emit({ type: "alert", level: "error", text: "Too many wrong PINs. Try again later." });
          return;
        }
        throw e;
      }
      if (!ok) {
        entry.emit({ type: "alert", level: "warn", text: "Incorrect PIN" });
        return;
      }
    }
    if (!this.entries.has(msg.id)) return; // answered while the PIN was being checked

    if (msg.decision === "approve_always" && entry.req.tier === "T2") this.addRule(entry.req);
    this.finish(msg.id, { approved: true }, msg.decision);
  }

  denyAll(reason: string): void {
    for (const id of [...this.entries.keys()]) this.finish(id, { approved: false, reason }, "deny");
  }

  private addRule(req: ApprovalRequest): void {
    const args = (req.args ?? {}) as Record<string, unknown>;
    if (req.tool === "shell.run") {
      const cmd = typeof args.command === "string" ? args.command.trim() : "";
      if (cmd && isSimpleCommand(cmd)) this.deps.policy.addRule(req.tool, { command: cmd });
      return;
    }
    this.deps.policy.addRule(req.tool, { argEquals: args });
  }

  private finish(id: string, outcome: ApprovalOutcome, decision: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    this.deps.db.prepare("update approvals set decision = ?, decided_at = ? where id = ?").run(decision, Date.now(), id);
    this.deps.audit.log("owner", "approval.decided", { id, tool: entry.info.tool, decision, approved: outcome.approved });
    entry.emit({ type: "approval.resolved", id });
    entry.resolve(outcome);
  }
}
