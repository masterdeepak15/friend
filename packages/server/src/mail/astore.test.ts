import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { MailAutomationStore } from "./astore";
import { MailStore } from "./store";

function rig() {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-mailauto-")));
  let now = 1_000_000;
  const store = new MailStore(db, () => now);
  const a = new MailAutomationStore(db, () => now);
  const acct = store.createAccount({ name: "Support", address: "s@corp.com", imap: { host: "i", port: 993, tls: true }, smtp: { host: "s", port: 465, secure: true }, username: "u", owners: ["b@corp.com"], systems: [] });
  return { db, store, a, acct, advance: (ms: number) => (now += ms) };
}

describe("templates", () => {
  it("are saved by name (saving again replaces), listed and removed", () => {
    const { a } = rig();
    a.saveTemplate({ name: "Server-Down", subject: "{{server}} is down", text: "Since {{since}}" });
    a.saveTemplate({ name: "server-down", subject: "ALERT {{server}}", text: "Since {{since}}" });
    expect(a.listTemplates()).toHaveLength(1);
    expect(a.getTemplate("SERVER-DOWN")).toMatchObject({ subject: "ALERT {{server}}" });
    expect(a.removeTemplate("server-down")).toBe(true);
    expect(a.getTemplate("server-down")).toBeNull();
  });
});

describe("roles, rules and cases", () => {
  it("a role has guidelines and defaults to asking before it answers by itself", () => {
    const { a, acct } = rig();
    const r = a.createRole({ accountId: acct.id, name: "Support agent", guidelines: "Be kind. Never promise refunds." });
    expect(r).toMatchObject({ name: "Support agent", autoAnswer: false, enabled: true });
    expect(() => a.createRole({ accountId: acct.id, name: "support AGENT", guidelines: "x" })).toThrow(/already/i);
    a.updateRole(r.id, { autoAnswer: true });
    expect(a.getRole("support agent")).toMatchObject({ autoAnswer: true });
  });

  it("rules keep their order, and removing a role removes the rules that sent mail to it", () => {
    const { a, acct } = rig();
    const role = a.createRole({ accountId: acct.id, name: "R", guidelines: "g" });
    a.addRule(acct.id, { name: "invoices", conditions: { subjectContains: "invoice" }, action: "role", roleId: role.id });
    a.addRule(acct.id, { name: "spam", conditions: { from: ["@spam.io"] }, action: "ignore" });
    expect(a.listRules(acct.id).map((r) => r.name)).toEqual(["invoices", "spam"]);
    a.removeRole(role.id);
    expect(a.listRules(acct.id).map((r) => r.name)).toEqual(["spam"]);
  });

  it("one case per conversation: more mail in it reopens the same case", () => {
    const { a, acct } = rig();
    const role = a.createRole({ accountId: acct.id, name: "R", guidelines: "g" });
    const c1 = a.openCase({ accountId: acct.id, roleId: role.id, threadId: "t1", subject: "Invoice", from: "ann@x.com", mailId: "1" });
    a.updateCase(c1.id, { status: "done", note: "sent the invoice" });
    const c2 = a.openCase({ accountId: acct.id, roleId: role.id, threadId: "t1", subject: "Invoice", from: "ann@x.com", mailId: "2" });
    expect(c2.id).toBe(c1.id);
    expect(c2).toMatchObject({ status: "open", note: "sent the invoice", lastMailId: "2" });
    a.openCase({ accountId: acct.id, roleId: role.id, threadId: "t2", subject: "Other", from: "bob@x.com", mailId: "3" });
    expect(a.listCases({ status: "open" })).toHaveLength(2);
    a.updateCase(c1.id, { status: "escalated" });
    expect(a.listCases({ status: "escalated" })).toHaveLength(1);
  });
});

describe("schedules and watches", () => {
  it("a new schedule counts as run now (it waits for its time), and a run is recorded", () => {
    const { a, advance } = rig();
    const s = a.addSchedule({ name: "morning", kind: "daily", at: "08:00", instruction: "email me the status" });
    expect(s.lastRun).toBe(1_000_000);
    advance(5000);
    a.markScheduleRun(s.id);
    expect(a.listSchedules()[0]!.lastRun).toBe(1_005_000);
    expect(() => a.addSchedule({ name: "MORNING", kind: "daily", at: "09:00", instruction: "x" })).toThrow(/already/i);
    expect(a.removeSchedule("morning")).toBe(true);
  });

  it("a watch starts unknown, keeps what the last check saw, and goes away on removal", () => {
    const { a } = rig();
    const w = a.addWatch({ name: "shop", kind: "http", target: "https://shop.example.com", intervalSec: 300, instruction: "email me" });
    expect(w).toMatchObject({ state: "unknown", fails: 0, intervalSec: 300, enabled: true });
    a.recordCheck(w.id, { state: "down", fails: 2, detail: "HTTP 502", changed: true });
    expect(a.listWatches()[0]).toMatchObject({ state: "down", fails: 2, detail: "HTTP 502", lastChange: 1_000_000 });
    expect(a.removeWatch("SHOP")).toBe(true);
    expect(a.listWatches()).toEqual([]);
  });
});
