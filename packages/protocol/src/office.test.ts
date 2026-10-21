import { describe, expect, it } from "vitest";
import { ClientMsg, OfficePolicy, OfficeProject, OfficeRole, ServerMsg, SLUG, TICKET_STATUSES, TOOL_DEFS, WORKER_STATUSES, describeCall } from "./index";

describe("slugs, statuses and the settings shapes", () => {
  it("accepts a lowercase slug and rejects the rest", () => {
    expect(SLUG.test("coder-2")).toBe(true);
    expect(SLUG.test("Coder")).toBe(false);
    expect(SLUG.test("-x")).toBe(false);
    expect(SLUG.test("a".repeat(25))).toBe(false);
    expect(SLUG.test("a".repeat(24))).toBe(true);
  });

  it("names the statuses", () => {
    expect([...WORKER_STATUSES]).toEqual(["starting", "running", "waiting", "idle", "paused", "stopped", "failed"]);
    expect([...TICKET_STATUSES]).toEqual(["todo", "doing", "review", "done", "blocked"]);
  });

  it("holds a role to its shape and never allows a bypass of permissions", () => {
    const ok = { id: "scribe", title: "Scribe", instructions: "Write docs.", model: "", permission: "default" };
    expect(OfficeRole.safeParse(ok).success).toBe(true);
    expect(OfficeRole.safeParse({ ...ok, permission: "acceptEdits" }).success).toBe(true);
    expect(OfficeRole.safeParse({ ...ok, permission: "bypass" }).success).toBe(false);
    expect(OfficeRole.safeParse({ ...ok, permission: "bypassPermissions" }).success).toBe(false);
    expect(OfficeRole.safeParse({ ...ok, id: "Scribe" }).success).toBe(false);
    expect(OfficeRole.safeParse({ ...ok, title: "" }).success).toBe(false);
    expect(OfficeRole.safeParse({ ...ok, instructions: "x".repeat(4001) }).success).toBe(false);
  });

  it("holds a project and a policy to their caps", () => {
    const p = { id: "site", name: "Site", folder: "C:\\work\\site", goal: "", extraFolders: [] };
    expect(OfficeProject.safeParse(p).success).toBe(true);
    expect(OfficeProject.safeParse({ ...p, folder: "" }).success).toBe(false);
    expect(OfficeProject.safeParse({ ...p, extraFolders: Array.from({ length: 6 }, (_, i) => `C:\\x${i}`) }).success).toBe(false);
    expect(OfficePolicy.safeParse({ allowTools: [], denyCommands: [] }).success).toBe(true);
    expect(OfficePolicy.safeParse({ allowTools: Array.from({ length: 41 }, (_, i) => `T${i}`), denyCommands: [] }).success).toBe(false);
  });
});

describe("the messages", () => {
  const worker = { id: "w1", name: "Ada", roleId: "scribe", projectId: "site", status: "running", ticketId: 1, detail: "Write a.txt", tokens: 10, budget: null, startedAt: 1 };
  const quota = { fiveHour: { utilization: 0.42, resetsAt: 1792516200 }, sevenDay: null };

  it("carries the office state and a feed line", () => {
    expect(ServerMsg.safeParse({ type: "office.state", enabled: true, workers: [worker], tickets: [{ id: 1, projectId: "site", title: "Fix it", status: "doing", workerId: "w1" }], quota }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "office.feed", workerId: "w1", at: 1, kind: "tool", text: "Write a.txt" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "office.feed", workerId: "w1", at: 1, kind: "x", text: "a" }).success).toBe(false);
    expect(ServerMsg.safeParse({ type: "office.feed", workerId: "w1", at: 1, kind: "text", text: "a".repeat(201) }).success).toBe(false);
    expect(ServerMsg.safeParse({ type: "office.state", enabled: true, workers: [{ ...worker, utilization: 1, status: "flying" }], tickets: [], quota }).success).toBe(false);
  });

  it("accepts stop with and without a worker, and say with text", () => {
    expect(ClientMsg.safeParse({ type: "office.stop" }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "office.stop", workerId: "w1" }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "office.say", workerId: "w1", text: "hello" }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "office.say", workerId: "w1", text: "" }).success).toBe(false);
  });
});

describe("the six office tools", () => {
  const def = (n: string) => TOOL_DEFS.find((t) => t.name === n);
  it("exist with the planned tiers, run on the gateway", () => {
    const want: Record<string, string> = { "office.status": "T0", "office.hire": "T1", "office.assign": "T2", "office.say": "T2", "office.review": "T1", "office.stop": "T1" };
    for (const [name, tier] of Object.entries(want)) {
      expect(def(name)?.baseTier, name).toBe(tier);
      expect(def(name)?.target, name).toBe("gateway");
    }
  });

  it("office.report reads a ticket's report without asking", () => {
    const d = TOOL_DEFS.find((t) => t.name === "office.report")!;
    expect(d.baseTier).toBe("T0");
    expect(d.input.safeParse({ ticket: 3 }).success).toBe(true);
    expect(d.input.safeParse({}).success).toBe(false);
    expect(describeCall("office.report", { ticket: 3 })).toMatch(/3/);
  });

  it("check their arguments", () => {
    expect(def("office.assign")!.input.safeParse({ worker: "w1", title: "Fix login" }).success).toBe(true);
    expect(def("office.assign")!.input.safeParse({ worker: "w1", title: "" }).success).toBe(false);
    expect(def("office.stop")!.input.safeParse({}).success).toBe(true);
    expect(def("office.review")!.input.safeParse({ ticket: 3, accept: true }).success).toBe(true);
    expect(def("office.hire")!.input.safeParse({ role: "scribe", project: "site", name: "Ada" }).success).toBe(true);
  });

  it("describe what will happen in plain words", () => {
    expect(describeCall("office.assign", { worker: "w1", title: "Fix login", description: "SECRET LONG TEXT" })).toMatch(/w1.*Fix login/);
    expect(describeCall("office.assign", { worker: "w1", title: "Fix login", description: "SECRET LONG TEXT" })).not.toMatch(/SECRET/);
    expect(describeCall("office.stop", {})).toMatch(/all/i);
    expect(describeCall("office.stop", { worker: "Ada" })).toMatch(/Ada/);
    expect(describeCall("office.hire", { role: "scribe", project: "site" })).toMatch(/scribe/);
  });

  it("shows an Office settings change whole on the PIN card, so nothing is hidden by a clip", () => {
    const role = { id: "scribe", title: "Scribe", instructions: "x".repeat(900), model: "", permission: "default" };
    const text = describeCall("settings.set", { settings: { office: { roles: [role] } } });
    expect(text).toContain("x".repeat(900));
  });

  it("describe a worker's own question in full, so the owner sees the whole command", () => {
    const cmd = "npm test -- " + "x".repeat(400);
    const text = describeCall("office.action", { worker: "Ada", workerId: "w1", summary: `Run: ${cmd}` });
    expect(text).toMatch(/^Worker Ada wants to Run: npm test/);
    expect(text).toContain(cmd);
  });
});
