import type { ServerMsg } from "@friend/protocol";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig, sanitizeOffice } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { Office } from "./office";
import { OfficeStore } from "./store";

/** Starts a real worker (the signed-in `claude` program) and checks the whole loop. Run with FRIEND_LIVE_CLAUDE=1. */
const live = process.env.FRIEND_LIVE_CLAUDE === "1" ? describe : describe.skip;

const claudeProcesses = (): number => {
  try {
    const out = execFileSync(process.platform === "win32" ? "tasklist" : "ps", process.platform === "win32" ? ["/FI", "IMAGENAME eq claude.exe", "/NH"] : ["-A", "-o", "comm"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((l) => /^claude(\.exe)?\b/i.test(l.trim())).length;
  } catch {
    return 0;
  }
};
const until = async (cond: () => boolean, ms: number) => {
  for (let t = 0; t < ms && !cond(); t += 250) await new Promise((r) => setTimeout(r, 250));
};

live("a real worker", () => {
  it("writes a file after the owner approves it, is refused an install, reports tokens and the quota, and leaves no process behind", async () => {
    const before = claudeProcesses();
    const dir = mkdtempSync(join(tmpdir(), "friend-office-live-"));
    const folder = join(dir, "project");
    mkdirSync(folder);
    const db = openDb(dir);
    const audit = new Audit(db);
    const auth = new Auth(db, audit);
    await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
    const config = loadConfig(dir);
    config.office = sanitizeOffice({
      enabled: true,
      maxConcurrent: 1,
      pauseAtWindow: 0,
      roles: [{ id: "scribe", title: "Scribe", instructions: "You are a careful assistant. Do exactly what the ticket says.", model: "", permission: "default" }],
      projects: [{ id: "p", name: "Project", folder, goal: "", extraFolders: [] }],
      policy: { allowTools: ["Read"], denyCommands: [] },
    });
    const approvals = new Approvals({ auth, policy: new PolicyEngine(db, config), audit, db }, 60_000);
    const seen: ServerMsg[] = [];
    const asked: string[] = [];
    const usage: { source: string; input: number; output: number }[] = [];
    const office = new Office({
      config: () => config,
      store: new OfficeStore(db),
      approvals,
      audit,
      usage: (e) => usage.push(e),
      emit: (m) => {
        seen.push(m);
        if (m.type === "approval.request") {
          asked.push(m.summary);
          // the owner says yes to writing the file and no to anything that installs
          void approvals.respond({ id: m.id, decision: /install/i.test(m.summary) ? "deny" : "approve" }, "127.0.0.1");
        }
      },
      dataDir: dir,
    });
    try {
      const hired = office.hire({ role: "scribe", project: "p", name: "Ada" });
      if (!hired.ok) throw new Error(hired.error);
      const t = office.assign({ worker: "Ada", title: "Create hello.txt containing hi, then run `npm install left-pad`. Report what happened." });
      if (!t.ok) throw new Error(t.error);
      await until(() => office.status().tickets.some((x) => x.status === "review" || x.status === "blocked" || x.status === "done"), 240_000);
      const status = office.status();
      console.log("tickets", JSON.stringify(status.tickets), "workers", JSON.stringify(status.workers.map((w) => [w.status, w.detail, w.tokens])), "asked", JSON.stringify(asked), "quota", JSON.stringify(status.quota));
      expect(existsSync(join(folder, "hello.txt"))).toBe(true);
      expect(readFileSync(join(folder, "hello.txt"), "utf8").toLowerCase()).toContain("hi");
      expect(asked.some((s) => /hello\.txt/i.test(s))).toBe(true);
      expect(asked.some((s) => /install/i.test(s))).toBe(true);
      expect(existsSync(join(folder, "node_modules"))).toBe(false);
      expect(status.tickets[0]!.status === "review" || status.tickets[0]!.status === "blocked").toBe(true);
      expect(status.workers[0]!.tokens).toBeGreaterThan(0);
      expect(usage.length).toBeGreaterThan(0);
      expect(status.quota.fiveHour ?? status.quota.sevenDay).not.toBeNull();
      expect(seen.some((m) => m.type === "office.feed" && /denied|not approved|refus/i.test(m.text))).toBe(true);
    } finally {
      await office.shutdown();
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(claudeProcesses()).toBeLessThanOrEqual(before);
  }, 300_000);
});
