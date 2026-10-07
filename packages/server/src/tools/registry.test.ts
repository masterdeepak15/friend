import { describe, expect, it } from "vitest";
import { getToolDef, lexicalInsideRoots, toolSpecs, pathArg } from "./registry";

describe("registry", () => {
  it("finds tools by name and returns undefined for unknown", () => {
    expect(getToolDef("fs.read")?.baseTier).toBe("T0");
    expect(getToolDef("nope")).toBeUndefined();
  });
  it("builds provider tool specs with JSON schemas", () => {
    const spec = toolSpecs().find((s) => s.name === "shell.run")!;
    expect(spec.description.length).toBeGreaterThan(5);
    expect(JSON.stringify(spec.inputSchema)).toContain("command");
  });
  it("lexicalInsideRoots handles dotdot, case and separators", () => {
    const root = "C:\\work";
    expect(lexicalInsideRoots("C:\\work\\a\\b.txt", [root])).toBe(true);
    expect(lexicalInsideRoots("c:/WORK/a", [root])).toBe(true);
    expect(lexicalInsideRoots("C:\\work\\..\\Windows", [root])).toBe(false);
    expect(lexicalInsideRoots("C:\\work-evil\\x", [root])).toBe(false);
    expect(lexicalInsideRoots("D:\\work\\x", [root])).toBe(false);
  });
  it("lexicalInsideRoots resolves relative paths against the first root", () => {
    expect(lexicalInsideRoots("notes.txt", ["C:\\work"])).toBe(true);
    expect(lexicalInsideRoots("sub\\a.txt", ["C:\\work"])).toBe(true);
    expect(lexicalInsideRoots("..\\secret.txt", ["C:\\work"])).toBe(false);
  });
  it("lexicalInsideRoots is false when no roots are configured", () => {
    expect(lexicalInsideRoots("C:\\work\\a", [])).toBe(false);
  });
  it("pathArg extracts the path argument of file tools", () => {
    expect(pathArg("fs.read", { path: "a" })).toBe("a");
    expect(pathArg("shell.run", { command: "dir", cwd: "C:\\x" })).toBe("C:\\x");
    expect(pathArg("system.info", {})).toBeUndefined();
  });
});
