import { describeCall, type ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./approvals";
import { Audit } from "./audit";
import { currentRequest, runWithRequest } from "./auditContext";
import { Auth } from "./auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { PolicyEngine } from "./policy/engine";

let approvals: Approvals;
let policy: PolicyEngine;
let audit: Audit;
let emitted: ServerMsg[];
const emit = (m: ServerMsg) => emitted.push(m);
const pin = "123456";

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-appr-"));
  const db = openDb(dir);
  audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "J" });
  policy = new PolicyEngine(db, loadConfig(dir));
  approvals = new Approvals({ auth, policy, audit, db }, 120_000);
  emitted = [];
});
afterEach(() => vi.useRealTimers());

const t2 = { tool: "shell.run", args: { command: "git status" }, tier: "T2" as const, needsPin: false };
const t3 = { tool: "shell.run", args: { command: "rm -rf x" }, tier: "T3" as const, needsPin: true };
const requestMsg = () => emitted.find((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>;

describe("Approvals", () => {
  it("emits a request whose summary is built from the real arguments", () => {
    void approvals.request(t2, emit);
    expect(requestMsg().summary).toBe(describeCall("shell.run", t2.args));
    expect(requestMsg().needsPin).toBe(false);
    expect(approvals.pending()?.id).toBe(requestMsg().id);
  });

  it("resolves approved when the owner approves", async () => {
    const p = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "approve" }, "1.1.1.1");
    expect(await p).toEqual({ approved: true });
    expect(approvals.pending()).toBeNull();
    expect(emitted.some((m) => m.type === "approval.resolved")).toBe(true);
  });

  it("resolves denied when the owner denies", async () => {
    const p = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "deny" }, "1.1.1.1");
    expect((await p).approved).toBe(false);
  });

  it("keeps a PIN-protected request pending on a missing or wrong PIN and approves on the right one", async () => {
    const p = approvals.request(t3, emit);
    const id = requestMsg().id;
    await approvals.respond({ id, decision: "approve" }, "2.2.2.2");
    await approvals.respond({ id, decision: "approve", pin: "000000" }, "2.2.2.2");
    expect(approvals.pending()?.id).toBe(id);
    expect(emitted.filter((m) => m.type === "alert").length).toBeGreaterThanOrEqual(2);
    await approvals.respond({ id, decision: "approve", pin }, "2.2.2.2");
    expect(await p).toEqual({ approved: true });
  });

  it("denies when nobody answers within the timeout", async () => {
    vi.useFakeTimers();
    const p = approvals.request(t2, emit);
    await vi.advanceTimersByTimeAsync(120_001);
    const r = await p;
    expect(r.approved).toBe(false);
    expect(r.reason).toMatch(/timed out/i);
    expect(approvals.pending()).toBeNull();
  });

  it("does not create a rule for approve_always on a T3 call", async () => {
    const p = approvals.request(t3, emit);
    await approvals.respond({ id: requestMsg().id, decision: "approve_always", pin }, "3.3.3.3");
    expect((await p).approved).toBe(true);
    expect(policy.listRules()).toHaveLength(0);
  });

  it("creates a rule for approve_always on a T2 call", async () => {
    const p = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "approve_always" }, "4.4.4.4");
    expect((await p).approved).toBe(true);
    expect(policy.listRules()).toHaveLength(1);
    expect(policy.decide({ tool: "shell.run", baseTier: "T2", args: t2.args, trust: "owner", insideRoots: true })).toBe("allow");
  });

  it("does not create an always-rule for a chained shell command", async () => {
    const chained = { ...t2, args: { command: "git status && calc" } };
    const p = approvals.request(chained, emit);
    await approvals.respond({ id: requestMsg().id, decision: "approve_always" }, "4.4.4.4");
    await p;
    expect(policy.listRules()).toHaveLength(0);
  });

  it("ignores and audits a response to an unknown or already-answered id", async () => {
    const p = approvals.request(t2, emit);
    const id = requestMsg().id;
    await approvals.respond({ id, decision: "approve" }, "5.5.5.5");
    await p;
    await approvals.respond({ id, decision: "deny" }, "5.5.5.5");
    await approvals.respond({ id: "nope", decision: "approve" }, "5.5.5.5");
    expect(audit.list(20).filter((r) => r.kind === "approval.ignored")).toHaveLength(2);
  });

  it("records the decision in the approvals table", async () => {
    const p = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "approve" }, "6.6.6.6");
    await p;
    expect(audit.list(20).some((r) => r.kind === "approval.decided")).toBe(true);
  });

  it("tells the phone side about a request and how it ended, and never lets it break an approval", async () => {
    const offer = vi.fn();
    const settled = vi.fn();
    approvals.setRemote({ offer, settled });
    const p = approvals.request(t2, emit);
    expect(offer).toHaveBeenCalledWith(expect.objectContaining({ id: requestMsg().id, tool: "shell.run" }), t2);
    await approvals.respond({ id: requestMsg().id, decision: "approve" }, "phone");
    await p;
    expect(settled).toHaveBeenCalledWith(requestMsg().id, "approve");

    emitted = [];
    approvals.setRemote({
      offer: () => {
        throw new Error("boom");
      },
      settled: () => {
        throw new Error("boom");
      },
    });
    const q = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "deny" }, "phone");
    expect((await q).approved).toBe(false);
  });

  it("does not offer a request that is already going to the phone another way", () => {
    const offer = vi.fn();
    approvals.setRemote({ offer, settled: () => {} });
    void approvals.request({ ...t2, remote: false }, emit);
    expect(offer).not.toHaveBeenCalled();
  });
});


describe("Approvals in the audit trail", () => {
  const kinds = (k: string) => audit.list(50).filter((r) => r.kind === k).reverse();

  it("writes the request with the card text, tier and whether a PIN is needed, inside the request that asked", async () => {
    let asked = "";
    const p = runWithRequest({ prefix: "chat", actorKind: "owner" }, () => {
      asked = currentRequest()!.requestId;
      return approvals.request(t2, emit);
    });
    const [r] = kinds("approval.requested");
    expect(r).toMatchObject({ actorKind: "assistant", target: "shell.run", outcome: "waiting", requestId: asked, detail: { id: requestMsg().id, tool: "shell.run", tier: "T2", needsPin: false } });
    expect(String(r!.detail.summary)).toContain("git status");
    await approvals.respond({ id: requestMsg().id, decision: "deny" }, "1.1.1.1");
    await p;
  });

  it("writes who decided and how: the screen, the address, and whether a PIN was used (never the PIN)", async () => {
    const p = approvals.request(t3, emit);
    const id = requestMsg().id;
    await approvals.respond({ id, decision: "approve", pin }, "2.2.2.2");
    await p;
    const [d] = kinds("approval.decided");
    expect(d).toMatchObject({ actorKind: "owner", target: "shell.run", outcome: "done", detail: { id, decision: "approve", approved: true, by: "screen", ip: "2.2.2.2", pinUsed: true } });
    expect(JSON.stringify(d!.detail)).not.toContain(pin);
  });

  it("a refusal is outcome refused, and the way in is taken from where it came from", async () => {
    const p1 = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "deny" }, "phone", "phone-button");
    await p1;
    emitted = [];
    const p2 = approvals.request(t2, emit);
    await approvals.respond({ id: requestMsg().id, decision: "approve" }, "alexa");
    await p2;
    const [first, second] = kinds("approval.decided");
    expect(first).toMatchObject({ outcome: "refused", detail: { by: "phone-button", pinUsed: false } });
    expect(second).toMatchObject({ outcome: "done", detail: { by: "alexa" } });
  });

  it("a request nobody answers is an approval.timeout, not a decision", async () => {
    vi.useFakeTimers();
    const p = approvals.request(t2, emit);
    await vi.advanceTimersByTimeAsync(120_001);
    expect((await p).approved).toBe(false);
    expect(kinds("approval.timeout")[0]).toMatchObject({ outcome: "refused", detail: { id: requestMsg().id, tool: "shell.run" } });
    expect(kinds("approval.decided")).toHaveLength(0);
  });

  it("an answer for something no longer waiting is recorded as ignored", async () => {
    await approvals.respond({ id: "00000000-0000-4000-8000-000000000000", decision: "approve" }, "3.3.3.3");
    expect(kinds("approval.ignored")[0]).toMatchObject({ detail: { ip: "3.3.3.3" } });
  });
});
