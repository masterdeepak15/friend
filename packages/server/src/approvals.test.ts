import { describeCall, type ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "./approvals";
import { Audit } from "./audit";
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
});
