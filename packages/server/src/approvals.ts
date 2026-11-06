import { describeCall, type ApprovalRespond, type PendingApproval, type ServerMsg, type Tier } from "@friend/protocol";
import { randomUUID } from "node:crypto";
import { currentRequest } from "./auditContext";
import type { Audit } from "./audit";
import { LockoutError, type Auth } from "./auth";
import type { Db } from "./db";
import { isSimpleCommand } from "./policy/classify";
import { ASK_EVERY_TIME, type PolicyEngine } from "./policy/engine";

export interface ApprovalRequest {
  tool: string;
  args: unknown;
  tier: Tier;
  needsPin: boolean;
  /** Name of the device the call will run on, shown on the approval card. */
  device?: string | null;
  /** False when the question is already going to the owner's phone another way (a speaker device); default true. */
  remote?: boolean;
}

/** Asks the owner somewhere other than the screen (their phone). Must never throw into the approval. */
export interface RemoteAsk {
  offer(info: PendingApproval, req: ApprovalRequest): void;
  settled(id: string, decision: string): void;
}
export interface ApprovalOutcome {
  approved: boolean;
  reason?: string;
}

/** A web address or a search can be private: the web and browser tools never put their words in the audit trail. */
const PRIVATE_TOOL = /^(web|browser)\./;

/** How an answer reached Friend: for the audit trail. */
export type AnsweredBy = "screen" | "phone-button" | "phone-reply" | "alexa";

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

  private remote: RemoteAsk | null = null;

  constructor(private deps: Deps, private timeoutMs = 120_000) {}

  setRemote(r: RemoteAsk | null): void {
    this.remote = r;
  }

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
    this.record({ kind: "approval.requested", actorKind: currentRequest()?.actorKind === "worker" ? "worker" : "assistant", target: info.tool, outcome: "waiting", detail: { id, tool: info.tool, ...(PRIVATE_TOOL.test(info.tool) ? {} : { summary: info.summary }), tier: info.tier, needsPin: info.needsPin } });
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(id, { approved: false, reason: "Approval timed out" }, "timeout"), this.timeoutMs);
      this.entries.set(id, { info, req, emit, resolve, timer });
      emit({ type: "approval.request", ...info });
      if (req.remote !== false) this.tell(() => this.remote?.offer(info, req));
    });
  }

  pending(): PendingApproval | null {
    const first = this.entries.values().next();
    return first.done ? null : first.value.info;
  }

  async respond(msg: Pick<ApprovalRespond, "id" | "decision" | "pin">, ip: string, by?: AnsweredBy): Promise<void> {
    const how: AnsweredBy = by ?? (ip === "alexa" ? "alexa" : ip === "phone" ? "phone-reply" : "screen");
    let pinUsed = false;
    const entry = this.entries.get(msg.id);
    if (!entry) {
      this.deps.audit.log("owner", "approval.ignored", { id: msg.id, ip });
      return;
    }
    if (msg.decision === "deny") return this.finish(msg.id, { approved: false, reason: "Denied by owner" }, "deny", { by: how, ip, pinUsed });

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
      pinUsed = true;
    }
    if (!this.entries.has(msg.id)) return; // answered while the PIN was being checked

    if (msg.decision === "approve_always" && entry.req.tier === "T2" && !ASK_EVERY_TIME.has(entry.req.tool)) this.addRule(entry.req);
    this.finish(msg.id, { approved: true }, msg.decision, { by: how, ip, pinUsed });
  }

  /** Denies every waiting request that matches, so its card leaves the screen (stopping one worker must not touch the others). Returns how many. */
  denyWhere(match: (req: ApprovalRequest) => boolean, reason: string): number {
    let n = 0;
    for (const [id, entry] of [...this.entries]) {
      if (!match(entry.req)) continue;
      this.finish(id, { approved: false, reason }, "deny");
      n++;
    }
    return n;
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

  /** Writes to the audit trail; the approval itself goes on if that fails. */
  private record(i: Parameters<Deps["audit"]["record"]>[0]): void {
    try {
      this.deps.audit.record(i);
    } catch {
      // the question is still asked and answered
    }
  }

  private finish(id: string, outcome: ApprovalOutcome, decision: string, who?: { by: AnsweredBy; ip: string; pinUsed: boolean }): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    this.deps.db.prepare("update approvals set decision = ?, decided_at = ? where id = ?").run(decision, Date.now(), id);
    if (decision === "timeout") this.record({ kind: "approval.timeout", actorKind: "system", target: entry.info.tool, outcome: "refused", detail: { id, tool: entry.info.tool } });
    else this.record({ kind: "approval.decided", actorKind: "owner", actorId: "owner", target: entry.info.tool, outcome: outcome.approved ? "done" : "refused", detail: { id, tool: entry.info.tool, decision, approved: outcome.approved, by: who?.by ?? "system", ip: who?.ip ?? "", pinUsed: who?.pinUsed ?? false, ...(outcome.reason ? { reason: outcome.reason } : {}) } });
    entry.emit({ type: "approval.resolved", id });
    this.tell(() => this.remote?.settled(id, decision));
    entry.resolve(outcome);
  }

  private tell(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.deps.audit.log("system", "approval.remote_failed", { message: String((e as Error).message).slice(0, 200) });
    }
  }
}
