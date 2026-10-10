import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type ApprovalMode } from "../config";
import { openDb } from "../db";
import { applySettings, refuseForAgent, settingsView } from "../settings";
import { PolicyEngine, type DecideInput } from "./engine";

function setup(mode?: ApprovalMode) {
  const dir = mkdtempSync(join(tmpdir(), "friend-modes-"));
  const config = loadConfig(dir);
  if (mode) config.approvals = mode;
  return { dir, config, engine: new PolicyEngine(openDb(dir), config) };
}
const owner = (tool: string, baseTier: DecideInput["baseTier"], extra: Partial<DecideInput> = {}): DecideInput => ({ tool, baseTier, args: {}, trust: "owner", insideRoots: true, ...extra });

describe("the approval modes", () => {
  it("manual (the default) asks exactly as before", () => {
    const { config, engine } = setup();
    expect(config.approvals).toBe("manual");
    expect(engine.decide(owner("shell.run", "T2"))).toBe("ask");
    expect(engine.decide(owner("fs.read", "T0", { insideRoots: false }))).toBe("ask");
    expect(engine.decide(owner("code.run", "T2"))).toBe("ask");
    expect(engine.decide(owner("fs.read", "T0"))).toBe("allow");
  });

  it("edits lets file work and the sandboxed code runner go ahead, anywhere, but commands still ask", () => {
    const { engine } = setup("edits");
    expect(engine.decide(owner("fs.write", "T1", { insideRoots: false }))).toBe("allow");
    expect(engine.decide(owner("fs.read", "T0", { insideRoots: false }))).toBe("allow");
    expect(engine.decide(owner("code.run", "T2"))).toBe("allow");
    expect(engine.decide(owner("shell.run", "T2"))).toBe("ask");
    expect(engine.decide(owner("plugin.thing", "T2"))).toBe("ask");
  });

  it("auto lets commands, plugin tools and connector tools go ahead", () => {
    const { engine } = setup("auto");
    expect(engine.decide(owner("shell.run", "T2"))).toBe("allow");
    expect(engine.decide(owner("plugin.thing", "T2"))).toBe("allow");
    expect(engine.decide(owner("mcp.chrome.navigate", "T2"))).toBe("allow");
  });

  it("no mode ever skips the PIN, the camera question, adding connectors or plugins, or Friend's own data folder", () => {
    for (const mode of ["edits", "auto"] as const) {
      const { engine } = setup(mode);
      expect(engine.decide(owner("shell.run", "T3"))).toBe("ask_with_pin");
      expect(engine.decide(owner("settings.set", "T3"))).toBe("ask_with_pin");
      expect(engine.decide(owner("camera.snap", "T2"))).toBe("ask");
      expect(engine.decide(owner("connectors.add", "T2"))).toBe("ask");
      expect(engine.decide(owner("plugins.create", "T2"))).toBe("ask");
      expect(engine.decide(owner("fs.write", "T1", { insideRoots: false, protectedPath: true }))).toBe("ask");
    }
  });

  it("never opens anything to guests or household members", () => {
    const { engine } = setup("auto");
    expect(engine.decide({ ...owner("shell.run", "T2"), trust: "guest" })).toBe("deny");
    expect(engine.decide({ ...owner("fs.read", "T0"), trust: "member" })).toBe("deny");
  });

  it("takes effect the moment the setting changes, without a restart", () => {
    const { config, engine } = setup();
    expect(engine.decide(owner("shell.run", "T2"))).toBe("ask");
    applySettings(config, { approvals: "auto" });
    expect(engine.decide(owner("shell.run", "T2"))).toBe("allow");
    applySettings(config, { approvals: "manual" });
    expect(engine.decide(owner("shell.run", "T2"))).toBe("ask");
  });
});

describe("the approval setting as a setting", () => {
  it("is shown on the screen, saved in the config file, and read back", () => {
    const { dir, config } = setup();
    applySettings(config, { approvals: "edits" });
    expect(settingsView(config).approvals).toBe("edits");
    saveConfig(config);
    expect(loadConfig(dir).approvals).toBe("edits");
  });

  it("falls back to manual for anything odd in the file, and refuses an unknown value", () => {
    const { dir, config } = setup();
    saveConfig({ ...config, approvals: "yolo" as ApprovalMode });
    expect(loadConfig(dir).approvals).toBe("manual");
    expect(() => applySettings(config, { approvals: "yolo" })).toThrow();
  });

  it("cannot be changed by the AI, even with the PIN", () => {
    expect(() => refuseForAgent({ approvals: "auto" })).toThrow(/only be changed by the owner/);
    expect(() => refuseForAgent({ voice: { speakTyped: true } })).not.toThrow();
  });
});
