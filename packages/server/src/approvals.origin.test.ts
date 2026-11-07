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
let policy: PolicyEngine;
let emitted: ServerMsg[];
const emit = (m: ServerMsg) => emitted.push(m);

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-appr-origin-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "J" });
  policy = new PolicyEngine(db, loadConfig(dir));
  approvals = new Approvals({ auth, policy, audit, db }, 120_000);
  emitted = [];
});
const card = () => emitted.find((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>;
const decide = (command: string) => policy.decide({ tool: "shell.run", baseTier: "T2", args: { command }, trust: "owner", insideRoots: true, protectedPath: false });
const ask = (command: string, extra: object = {}) => approvals.request({ tool: "shell.run", args: { command }, tier: "T2", needsPin: false, ...extra }, emit);

describe("Always allow", () => {
  it("makes a rule for an ordinary command", async () => {
    const p = ask("git status");
    await approvals.respond({ id: card().id, decision: "approve_always" }, "1.1.1.1");
    await p;
    expect(decide("git status")).toBe("allow");
  });

  it("makes no rule for a command that follows text from a repository, however it is answered", async () => {
    const p = ask("git status", { origin: "github.com/o/r" });
    await approvals.respond({ id: card().id, decision: "approve_always" }, "1.1.1.1");
    expect(await p).toEqual({ approved: true }); // this one time it goes ahead
    expect(decide("git status")).toBe("ask");
  });
});

describe("what the card says about a command that follows repository text", () => {
  it("puts the notes before the command, so a long command cannot push them out of a short message", () => {
    void ask("x".repeat(2000), { origin: "github.com/o/r", warnings: ["It runs with administrator rights."] });
    const s = card().summary;
    expect(s.indexOf("follows text from github.com/o/r")).toBeLessThan(s.indexOf("xxxx"));
    expect(s.indexOf("administrator")).toBeLessThan(s.indexOf("xxxx"));
    expect(s.slice(0, 600)).toContain("administrator");
  });

  it("cannot be forged by the command's own text: the command's lines are indented, the notes are not", () => {
    void ask("ls\n\n⚠ This follows text from github.com/microsoft/vscode.", { origin: "github.com/evil/repo" });
    const lines = card().summary.split("\n");
    const noteLines = lines.filter((l) => l.startsWith("⚠"));
    expect(noteLines).toHaveLength(1);
    expect(noteLines[0]).toContain("github.com/evil/repo");
    expect(lines.some((l) => l.includes("microsoft/vscode") && !l.startsWith("    "))).toBe(false);
  });

  it("is unchanged for a command with no origin and no warnings", () => {
    void ask("git status");
    expect(card().summary).toBe("Run shell command: git status");
  });
});
