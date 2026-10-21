import { describe, expect, it } from "vitest";
import { diffSettings, type OfficeSettings, type SettingsView } from "./settingsApi";

const role = { id: "scribe", title: "Scribe", instructions: "Write docs.", model: "", permission: "default" as const };
const project = { id: "site", name: "Site", folder: "C:\\work\\site", goal: "", extraFolders: [] };
const office: OfficeSettings = { enabled: false, maxConcurrent: 2, startTimeoutSec: 60, pauseAtWindow: 0.9, notifyFriend: true, budget: { perWorkerTokens: 0, totalTokens: 0 }, roles: [role], projects: [project], policy: { allowTools: ["Read"], denyCommands: ["git\\s+push"] } };
const view = (o: OfficeSettings) => ({ provider: "claude", model: "m", apiKeySet: false, view: "companion", look: {}, ollama: {}, claudeCode: {}, voice: {}, office: o }) as unknown as SettingsView;

describe("saving the office settings", () => {
  it("sends nothing when nothing changed", () => {
    expect(diffSettings(view(office), view(structuredClone(office)), "")).toEqual({});
  });

  it("sends only the numbers and switches that changed", () => {
    const after = structuredClone(office);
    after.enabled = true;
    after.maxConcurrent = 3;
    after.pauseAtWindow = 0;
    expect(diffSettings(view(office), view(after), "")).toEqual({ office: { enabled: true, maxConcurrent: 3, pauseAtWindow: 0 } });
  });

  it("sends only the budget field that changed", () => {
    const after = structuredClone(office);
    after.budget.perWorkerTokens = 500;
    expect(diffSettings(view(office), view(after), "")).toEqual({ office: { budget: { perWorkerTokens: 500 } } });
  });

  it("sends a list whole when it changed, including when it is emptied", () => {
    const after = structuredClone(office);
    after.roles = [];
    after.projects = [{ ...project, goal: "Ship it" }];
    after.policy.denyCommands = [];
    expect(diffSettings(view(office), view(after), "")).toEqual({ office: { roles: [], projects: after.projects, policy: { denyCommands: [] } } });
  });

  it("sends nothing about the office when the screen has no office settings", () => {
    const bare = { ...view(office), office: undefined } as unknown as SettingsView;
    expect(diffSettings(bare, bare, "")).toEqual({});
  });
});