import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "./approvals";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { PolicyEngine } from "./policy/engine";

let approvals: Approvals;
let emitted: ServerMsg[];
const emit = (m: ServerMsg) => emitted.push(m);
const req = (worker: string) => ({ tool: "office.action", args: { workerId: worker, summary: "x" }, tier: "T2" as const, needsPin: false });

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-appr2-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "J" });
  approvals = new Approvals({ auth, policy: new PolicyEngine(db, loadConfig(dir)), audit, db }, 120_000);
  emitted = [];
});

describe("Approvals.denyWhere", () => {
  it("denies only the matching requests, takes their cards off the screen, and says how many", async () => {
    const a = approvals.request(req("w1"), emit);
    const b = approvals.request(req("w2"), emit);
    const c = approvals.request(req("w1"), emit);
    const n = approvals.denyWhere((r) => (r.args as { workerId: string }).workerId === "w1", "Worker stopped");
    expect(n).toBe(2);
    await expect(a).resolves.toEqual({ approved: false, reason: "Worker stopped" });
    await expect(c).resolves.toEqual({ approved: false, reason: "Worker stopped" });
    expect(emitted.filter((m) => m.type === "approval.resolved")).toHaveLength(2);
    expect(approvals.pending()).not.toBeNull(); // w2 is still waiting
    approvals.denyAll("done");
    await expect(b).resolves.toMatchObject({ approved: false });
  });

  it("does nothing when nothing matches", () => {
    void approvals.request(req("w1"), emit);
    expect(approvals.denyWhere(() => false, "x")).toBe(0);
    expect(approvals.pending()).not.toBeNull();
    approvals.denyAll("done");
  });
});