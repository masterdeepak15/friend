import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sanitizeHud } from "./config";
import { applySettings, refuseForAgent, settingsView } from "./settings";

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-screen-tidy-")));

describe("the screen tidy settings", () => {
  it("default to 40 seconds, a limit by screen and tidying on", () => {
    expect(sanitizeHud({}).tidy).toEqual({ dockAfterSeconds: 40, maxChips: null, autoTidy: true });
  });
  it("fall back to the defaults for garbage", () => {
    expect(sanitizeHud({ tidy: { dockAfterSeconds: "x", maxChips: "7", autoTidy: "no" } }).tidy).toEqual({ dockAfterSeconds: 40, maxChips: null, autoTidy: true });
    expect(sanitizeHud({ tidy: "nope" }).tidy).toEqual({ dockAfterSeconds: 40, maxChips: null, autoTidy: true });
  });
  it("clamp the time to 0-3600 and the chip limit to 1-12", () => {
    expect(sanitizeHud({ tidy: { dockAfterSeconds: 99999, maxChips: 50 } }).tidy).toMatchObject({ dockAfterSeconds: 3600, maxChips: 12 });
    expect(sanitizeHud({ tidy: { dockAfterSeconds: -5, maxChips: 0 } }).tidy).toMatchObject({ dockAfterSeconds: 0, maxChips: 1 });
  });
  it("are saved by applySettings, merging, and shown in the view", () => {
    const config = fresh();
    applySettings(config, { hud: { tidy: { dockAfterSeconds: 90 } } });
    applySettings(config, { hud: { tidy: { autoTidy: false } } });
    expect(config.hud.tidy).toEqual({ dockAfterSeconds: 90, maxChips: null, autoTidy: false });
    expect(settingsView(config).hud.tidy).toEqual({ dockAfterSeconds: 90, maxChips: null, autoTidy: false });
  });
  it("refuse a time or a limit out of range", () => {
    const config = fresh();
    expect(() => applySettings(config, { hud: { tidy: { dockAfterSeconds: 5000 } } as never })).toThrow();
    expect(() => applySettings(config, { hud: { tidy: { maxChips: 99 } } as never })).toThrow();
    expect(config.hud.tidy.dockAfterSeconds).toBe(40);
  });
  it("cannot be changed by the assistant", () => {
    expect(() => refuseForAgent({ hud: { tidy: { autoTidy: false } } } as never)).toThrow(/only be changed by the owner/);
  });
});
