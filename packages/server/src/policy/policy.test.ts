import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { classifyShell } from "./classify";
import { PolicyEngine } from "./engine";

const patterns = loadConfig(mkdtempSync(join(tmpdir(), "friend-pol-"))).destructivePatterns;

describe("classifyShell", () => {
  it.each([
    "rm -rf /",
    "rm -fr build",
    "Remove-Item -Recurse -Force C:\\x",
    "format D:",
    "shutdown /s",
    "del /s /q C:\\temp",
    "reg delete HKLM\\Software\\X",
    "net user bob /add",
  ])("treats %s as T3", (cmd) => {
    expect(classifyShell(cmd, patterns)).toBe("T3");
  });
  it.each(["git status", "dir", "npm test", "echo hello"])("treats %s as T2", (cmd) => {
    expect(classifyShell(cmd, patterns)).toBe("T2");
  });
  it("is case-insensitive", () => {
    expect(classifyShell("REMOVE-ITEM -RECURSE x", patterns)).toBe("T3");
  });
});

describe("PolicyEngine", () => {
  let engine: PolicyEngine;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "friend-pol-"));
    engine = new PolicyEngine(openDb(dir), loadConfig(dir));
  });
  const base = { args: {}, trust: "owner" as const, insideRoots: true };

  it("denies guests everything except stage presence", () => {
    expect(engine.decide({ ...base, tool: "fs.read", baseTier: "T0", trust: "guest" })).toBe("deny");
    expect(engine.decide({ ...base, tool: "stage.presence", baseTier: "T0", trust: "guest" })).toBe("allow");
    expect(engine.decide({ ...base, tool: "stage.show", baseTier: "T0", trust: "guest" })).toBe("deny");
  });
  it("allows T0 for the owner", () => {
    expect(engine.decide({ ...base, tool: "fs.list", baseTier: "T0" })).toBe("allow");
  });
  it("allows T1 inside roots and asks outside", () => {
    expect(engine.decide({ ...base, tool: "fs.write", baseTier: "T1" })).toBe("allow");
    expect(engine.decide({ ...base, tool: "fs.write", baseTier: "T1", insideRoots: false })).toBe("ask");
  });
  it("asks for T0 file reads outside roots", () => {
    expect(engine.decide({ ...base, tool: "fs.read", baseTier: "T0", insideRoots: false })).toBe("ask");
  });
  it("asks for T2 without a rule and allows with a matching prefix rule", () => {
    const args = { command: "git status" };
    expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T2", args })).toBe("ask");
    engine.addRule("shell.run", { commandPrefix: "git status" });
    expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T2", args })).toBe("allow");
    expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T2", args: { command: "git status -s" } })).toBe("allow");
  });
  it("does not let a prefix rule match chained or piped commands", () => {
    engine.addRule("shell.run", { commandPrefix: "git status" });
    for (const command of ["git status && rm -rf x", "git status; calc", "git status | more", "git status `calc`", "git status $(calc)", "git status\ncalc"]) {
      expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T2", args: { command } })).toBe("ask");
    }
  });
  it("does not match a prefix that only shares leading characters", () => {
    engine.addRule("shell.run", { commandPrefix: "git status" });
    expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T2", args: { command: "git statusx" } })).toBe("ask");
  });
  it("requires the PIN for T3 even with a matching rule", () => {
    engine.addRule("shell.run", { commandPrefix: "rm" });
    expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T3", args: { command: "rm -rf x" } })).toBe("ask_with_pin");
  });
  it("matches argEquals rules on the given keys", () => {
    engine.addRule("fs.write", { argEquals: { path: "a.txt" } });
    expect(engine.decide({ ...base, tool: "fs.write", baseTier: "T2", args: { path: "a.txt", content: "x" } })).toBe("allow");
    expect(engine.decide({ ...base, tool: "fs.write", baseTier: "T2", args: { path: "b.txt" } })).toBe("ask");
  });
  it("stops matching a removed rule", () => {
    const id = engine.addRule("shell.run", { commandPrefix: "dir" });
    engine.removeRule(id);
    expect(engine.listRules()).toHaveLength(0);
    expect(engine.decide({ ...base, tool: "shell.run", baseTier: "T2", args: { command: "dir" } })).toBe("ask");
  });
});
