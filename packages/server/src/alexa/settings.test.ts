import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sanitizeAlexa, saveConfig } from "../config";
import { applySettings, refuseForAgent, settingsView } from "../settings";
import { invocationNameProblem } from "./invocation";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-alexa-"));
  return { dir, config: loadConfig(dir) };
};
const SKILL = "amzn1.ask.skill.46844077-2dc4-4bb2-8c76-60c103ab0076";
const USER = "amzn1.ask.account.AHXYZABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("the defaults", () => {
  it("start with Alexa not installed, no skill, no name and nobody allowed", () => {
    expect(fresh().config.alexa).toEqual({
      installed: false,
      enabled: false,
      skillId: "",
      invocationName: "",
      allowedUsers: [],
      skillName: "Friend Assistant",
      locales: ["en-IN", "hi-IN"],
      answerSeconds: 6.5,
      holdMinutes: 10,
      permissionSeconds: 120,
      requestsPerMinute: 60,
      maxDevices: 10,
      extraVoiceTools: [],
    });
  });
});

describe("what is read back from the saved file", () => {
  it("drops malformed users and skill ids, and keeps at most ten users", () => {
    const users = Array.from({ length: 14 }, (_, i) => ({ id: `${USER}${i}`, name: `Echo ${i}`, addedAt: i }));
    const a = sanitizeAlexa({ skillId: "not a skill", invocationName: "Jarvis!", allowedUsers: [...users, { id: "bad" }, 5, null] });
    expect(a.skillId).toBe("");
    expect(a.invocationName).toBe("");
    expect(a.allowedUsers).toHaveLength(10);
    expect(a.allowedUsers.every((u) => u.id.startsWith("amzn1.ask.account."))).toBe(true);
  });

  it("keeps a valid skill id and name, and counts a configured skill as installed", () => {
    const a = sanitizeAlexa({ skillId: SKILL, invocationName: "jarvis assistant" });
    expect(a).toMatchObject({ skillId: SKILL, invocationName: "jarvis assistant", installed: true, enabled: false });
    expect(sanitizeAlexa({}).installed).toBe(false);
    expect(sanitizeAlexa({ installed: false, skillId: SKILL }).installed).toBe(false);
  });
});

describe("the invocation name", () => {
  it.each(["jarvis assistant", "my friend", "home helper", "maya"])("accepts %s", (name) => expect(invocationNameProblem(name)).toBeNull());
  it.each([
    ["Jarvis Assistant", /lower/i],
    ["jarvis 2", /letters/i],
    ["ask jarvis", /ask/i],
    ["open my friend", /open/i],
    ["alexa helper", /alexa/i],
    ["echo helper", /echo/i],
    ["my skill", /skill/i],
    ["", /enter the name/i],
    ["maya 2", /letters/i],
    ["a".repeat(60) + " b", /long/i],
  ])("refuses %s", (name, why) => expect(invocationNameProblem(name)).toMatch(why));
});

describe("changing them from the screen", () => {
  it("saves the skill id and name, and counts that as installing", () => {
    const { config } = fresh();
    const applied = applySettings(config, { alexa: { skillId: SKILL, invocationName: "jarvis assistant" } });
    expect(config.alexa).toMatchObject({ installed: true, skillId: SKILL, invocationName: "jarvis assistant" });
    expect(applied.changed).toEqual(expect.arrayContaining(["alexa.skillId", "alexa.invocationName"]));
  });

  it("refuses a bad skill id, a bad name and unknown fields, and changes nothing", () => {
    const { config } = fresh();
    expect(() => applySettings(config, { alexa: { skillId: "hello" } })).toThrow();
    expect(() => applySettings(config, { alexa: { invocationName: "ask maya" } })).toThrow(/ask/i);
    expect(() => applySettings(config, { alexa: { allowedUsers: [] } })).toThrow();
    expect(() => applySettings(config, { alexa: { invocationName: "jarvis assistant" }, trading: { level: "orders" } })).toThrow();
    expect(config.alexa.invocationName).toBe("");
  });

  it("lets the skill id and name be cleared", () => {
    const { config } = fresh();
    applySettings(config, { alexa: { skillId: SKILL, invocationName: "jarvis assistant" } });
    applySettings(config, { alexa: { skillId: "", invocationName: "" } });
    expect(config.alexa).toMatchObject({ skillId: "", invocationName: "" });
  });
});

describe("what the screen is shown, and what the assistant may touch", () => {
  it("shows the allowed Echo devices by a short id only", () => {
    const { dir, config } = fresh();
    config.alexa.allowedUsers = [{ id: USER, name: "Kitchen", addedAt: 1 }];
    saveConfig(config);
    const view = settingsView(loadConfig(dir));
    expect(JSON.stringify(view)).not.toContain(USER);
    expect(view.alexa).toMatchObject({ installed: false, skillId: "", invocationName: "", allowed: [{ name: "Kitchen", id: "…" + USER.slice(-8) }] });
  });

  it("refuses the assistant any Alexa setting, even with the PIN", () => {
    expect(() => refuseForAgent({ alexa: { skillId: SKILL } })).toThrow(/only be changed by the owner/);
    expect(() => refuseForAgent({ voice: { speakTyped: true } })).not.toThrow();
  });
});
