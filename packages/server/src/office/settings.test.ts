import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OfficeRole } from "@friend/protocol";
import { loadConfig, sanitizeOffice } from "../config";
import { applySettings, refuseForAgent, settingsView } from "../settings";

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-office-")));
const role = (over: Record<string, unknown> = {}) => ({ id: "scribe", title: "Scribe", instructions: "Write docs.", model: "", permission: "default", ...over });
const project = (over: Record<string, unknown> = {}) => ({ id: "site", name: "Site", folder: "C:\\work\\site", goal: "", extraFolders: [], ...over });

describe("the office defaults", () => {
  it("are off, small, and seeded with editable starter data", () => {
    const o = fresh().office;
    expect(o).toMatchObject({ enabled: false, maxConcurrent: 2, startTimeoutSec: 60, pauseAtWindow: 0.9, notifyFriend: true, budget: { perWorkerTokens: 0, totalTokens: 0 }, projects: [] });
    expect(o.roles).toHaveLength(3);
    for (const r of o.roles) expect(OfficeRole.safeParse(r).success, r.id).toBe(true);
    expect(o.policy.allowTools.length).toBeGreaterThan(0);
    expect(o.policy.denyCommands.length).toBeGreaterThan(0);
  });
});

describe("the autonomy level", () => {
  it("is low unless the owner chose otherwise, and a value that is not a level is low", () => {
    expect(fresh().office.autonomy).toBe("low");
    expect(sanitizeOffice({ autonomy: "high" }).autonomy).toBe("high");
    expect(sanitizeOffice({ autonomy: "medium" }).autonomy).toBe("medium");
    for (const bad of ["max", "", 3, null, undefined]) expect(sanitizeOffice({ autonomy: bad }).autonomy).toBe("low");
  });

  it("is saved from the settings screen and refused for anything that is not a level", () => {
    const c = fresh();
    applySettings(c, { office: { autonomy: "high" } });
    expect(c.office.autonomy).toBe("high");
    expect(() => applySettings(c, { office: { autonomy: "everything" } })).toThrow();
    expect(c.office.autonomy).toBe("high");
  });

  it("cannot be changed by the assistant itself", () => {
    expect(() => refuseForAgent({ office: { autonomy: "high" } } as never)).toThrow(/only be changed by the owner/);
  });
});

describe("sanitizeOffice, what is read back from the saved file", () => {
  it("keeps every number inside its range", () => {
    expect(sanitizeOffice({ maxConcurrent: 99, startTimeoutSec: 1, pauseAtWindow: 5 })).toMatchObject({ maxConcurrent: 8, startTimeoutSec: 10, pauseAtWindow: 1 });
    expect(sanitizeOffice({ maxConcurrent: -1, startTimeoutSec: 99999, pauseAtWindow: -3 })).toMatchObject({ maxConcurrent: 1, startTimeoutSec: 600, pauseAtWindow: 0 });
    expect(sanitizeOffice({ budget: { perWorkerTokens: -5, totalTokens: 1.9 } }).budget).toEqual({ perWorkerTokens: 0, totalTokens: 2 });
    expect(sanitizeOffice("junk")).toMatchObject({ enabled: false, maxConcurrent: 2 });
  });

  it("drops a role with a bad id, a bad permission or a repeated id, and keeps the rest", () => {
    const o = sanitizeOffice({ roles: [role(), role({ id: "Bad" }), role({ id: "x", permission: "bypassPermissions" }), role({ title: "Again" }), role({ id: "second" })] });
    expect(o.roles.map((r) => r.id)).toEqual(["scribe", "second"]);
  });

  it("keeps an empty list the owner saved, instead of putting the starter data back", () => {
    const o = sanitizeOffice({ roles: [], policy: { allowTools: [], denyCommands: [] } });
    expect(o.roles).toEqual([]);
    expect(o.policy).toEqual({ allowTools: [], denyCommands: [] });
  });

  it("drops a project without a folder and tidies the ones it keeps", () => {
    const o = sanitizeOffice({ projects: [project(), project({ id: "none", folder: "" }), project({ id: "up", folder: "C:\\work\\x\\..\\site", extraFolders: ["C:\\a\\b\\..\\c", ""] })] });
    expect(o.projects.map((p) => p.id)).toEqual(["site", "up"]);
    expect(o.projects[1]).toMatchObject({ folder: "C:\\work\\site", extraFolders: ["C:\\a\\c"] });
  });
});

describe("saving the office settings", () => {
  it("saves numbers, replaces whole lists, and merges the budget", () => {
    const config = fresh();
    applySettings(config, { office: { maxConcurrent: 3, enabled: true, budget: { perWorkerTokens: 500 } } });
    expect(config.office).toMatchObject({ maxConcurrent: 3, enabled: true, budget: { perWorkerTokens: 500, totalTokens: 0 } });
    applySettings(config, { office: { roles: [role()], projects: [project()] } });
    expect(config.office.roles.map((r) => r.id)).toEqual(["scribe"]);
    expect(config.office.projects.map((p) => p.id)).toEqual(["site"]);
    applySettings(config, { office: { policy: { denyCommands: [] } } });
    expect(config.office.policy.denyCommands).toEqual([]);
    expect(config.office.policy.allowTools.length).toBeGreaterThan(0);
  });

  it("refuses what is not a role, a project or a number in range", () => {
    const config = fresh();
    expect(() => applySettings(config, { office: { roles: [role({ id: "BAD" })] } })).toThrow();
    expect(() => applySettings(config, { office: { roles: [role({ permission: "bypassPermissions" })] } as never })).toThrow();
    expect(() => applySettings(config, { office: { roles: [role(), role()] } })).toThrow(/same id/i);
    expect(() => applySettings(config, { office: { maxConcurrent: 99 } })).toThrow();
    expect(() => applySettings(config, { office: { pauseAtWindow: 2 } })).toThrow();
  });

  it("refuses a command pattern that is not a valid regular expression, and says which", () => {
    const config = fresh();
    expect(() => applySettings(config, { office: { policy: { denyCommands: ["(unclosed"] } } })).toThrow(/\(unclosed/);
  });

  it("can be changed by the assistant (it needs the owner's PIN each time, like every settings change)", () => {
    expect(() => refuseForAgent({ office: { enabled: true, projects: [project()] } } as never)).not.toThrow();
    expect(() => refuseForAgent({ office: { policy: { allowTools: ["Read"] } } } as never)).not.toThrow();
  });

  it("is shown as a copy, so changing the view does not change the settings", () => {
    const config = fresh();
    const view = settingsView(config);
    view.office.roles[0]!.title = "Changed";
    view.office.policy.allowTools.push("X");
    expect(config.office.roles[0]!.title).not.toBe("Changed");
    expect(config.office.policy.allowTools).not.toContain("X");
  });
});
