import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine, VOICE_TOOLS } from "./engine";

const engine = (approvals: "manual" | "auto" = "manual") => {
  const dir = mkdtempSync(join(tmpdir(), "friend-voicepolicy-"));
  const config = loadConfig(dir);
  config.approvals = approvals;
  return new PolicyEngine(openDb(dir), config);
};
const decide = (e: PolicyEngine, tool: string, baseTier: "T0" | "T1" | "T2" | "T3") => e.decide({ tool, baseTier, args: {}, trust: "voice-device", insideRoots: true });

describe("what a voice from a speaker device may do", () => {
  it("reading tools go ahead", () => {
    const e = engine();
    for (const t of ["weather.get", "task.list", "task.add", "memory.search", "system.info", "portfolio.summary", "portfolio.status", "reports.list", "stage.show"]) {
      expect(VOICE_TOOLS.has(t), t).toBe(true);
      expect(decide(e, t, "T2")).toBe("allow");
    }
  });

  it("an action that would normally ask the owner asks, even in auto mode", () => {
    for (const mode of ["manual", "auto"] as const) {
      expect(decide(engine(mode), "message.send", "T2")).toBe("ask");
      expect(decide(engine(mode), "reports.run", "T2")).toBe("ask");
    }
  });

  it("anything that needs the PIN is refused", () => {
    expect(decide(engine(), "reports.schedule", "T3")).toBe("deny");
    expect(decide(engine(), "reports.remove", "T3")).toBe("deny");
    expect(decide(engine(), "something.risky", "T3")).toBe("deny");
  });

  it("the PC, files, settings, connectors, plugins and the camera are never reachable by voice", () => {
    const e = engine("auto");
    for (const t of ["shell.run", "fs.read", "fs.write", "fs.list", "code.run", "settings.set", "settings.get", "connectors.add", "plugins.install", "integrations.configure", "camera.snap", "screen.look", "mcp.gmail.send", "plugin.tool"]) {
      expect(decide(e, t, "T1"), t).toBe("deny");
      expect(decide(e, t, "T2"), t).toBe("deny");
    }
  });

  it("an unlisted harmless read is not worth bothering the owner with, so it is refused", () => {
    expect(decide(engine(), "some.other.read", "T0")).toBe("deny");
  });

  it("does not change what the owner, a guest or a household member may do", () => {
    const e = engine();
    expect(e.decide({ tool: "shell.run", baseTier: "T2", args: {}, trust: "owner", insideRoots: true })).toBe("ask");
    expect(e.decide({ tool: "weather.get", baseTier: "T0", args: {}, trust: "guest", insideRoots: true })).toBe("deny");
    expect(e.decide({ tool: "weather.get", baseTier: "T0", args: {}, trust: "member", insideRoots: true })).toBe("allow");
  });
});
