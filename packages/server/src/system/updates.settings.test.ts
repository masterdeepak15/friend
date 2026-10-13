import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../config";
import { applySettings, refuseForAgent, settingsView } from "../settings";

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-upd-")));

describe("the automatic update setting", () => {
  it("is on unless the owner turns it off", () => {
    expect(fresh().updates).toEqual({ auto: true });
    const dir = mkdtempSync(join(tmpdir(), "friend-upd-"));
    expect(loadConfig(dir).updates).toEqual({ auto: true });
  });

  it("is kept across a save and a load", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-upd-"));
    const c = loadConfig(dir);
    c.updates.auto = false;
    saveConfig(c);
    expect(loadConfig(dir).updates).toEqual({ auto: false });
  });

  it("reads a damaged value as the default (on)", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-upd-"));
    const c = loadConfig(dir);
    (c as unknown as { updates: unknown }).updates = { auto: "no" };
    saveConfig(c);
    expect(loadConfig(dir).updates).toEqual({ auto: true });
  });

  it("is changed through the settings, and listed among what changed", () => {
    const c = fresh();
    const r = applySettings(c, { updates: { auto: false } });
    expect(c.updates.auto).toBe(false);
    expect(r.changed).toEqual(["updates.auto"]);
    expect(r.providerChanged).toBe(false);
  });

  it("refuses anything that is not a yes or no", () => {
    const c = fresh();
    for (const bad of ["no", 0, null]) expect(() => applySettings(c, { updates: { auto: bad } })).toThrow();
    expect(() => applySettings(c, { updates: { sneaky: true } })).toThrow();
    expect(c.updates.auto).toBe(true);
  });

  it("is shown to the screen", () => {
    const c = fresh();
    expect(settingsView(c).updates).toEqual({ auto: true });
    c.updates.auto = false;
    expect(settingsView(c).updates).toEqual({ auto: false });
  });

  it("is not something the assistant may change", () => {
    expect(() => refuseForAgent({ updates: { auto: false } })).toThrow(/owner/i);
  });
});
