import { describe, expect, it } from "vitest";
import { decideAction, type GateVerdict } from "./gate";

const policy = (over: Partial<{ allowTools: string[]; denyCommands: string[] }> = {}) => ({ allowTools: ["Read", "Write", "Edit", "Glob", "Grep"], denyCommands: [] as string[], ...over });
const ctx = (over: Record<string, unknown> = {}) => ({ folders: ["C:\\proj"], policy: policy(), shellPatterns: [] as string[], ...over }) as Parameters<typeof decideAction>[1];
const verdict = (tool: string, input: Record<string, unknown>, c = ctx()): GateVerdict => decideAction({ tool, input }, c);

describe("the project fence", () => {
  it("lets a path inside the folder carry on to the allow-list", () => {
    expect(verdict("Write", { file_path: "C:\\proj\\src\\a.ts" })).toEqual({ verdict: "allow" });
    expect(verdict("Read", { file_path: "C:\\proj" })).toEqual({ verdict: "allow" });
  });

  it("refuses a path that climbs out with ..", () => {
    expect(verdict("Write", { file_path: "C:\\proj\\..\\other\\x.txt" })).toMatchObject({ verdict: "deny", reason: expect.stringMatching(/outside the project/i) });
    expect(verdict("Read", { file_path: "..\\x" })).toMatchObject({ verdict: "deny" });
  });

  it("reads a relative path from the project folder", () => {
    expect(verdict("Read", { file_path: "src\\x" })).toEqual({ verdict: "allow" });
  });

  it("refuses another drive and a network path", () => {
    expect(verdict("Read", { file_path: "D:\\proj\\x" })).toMatchObject({ verdict: "deny" });
    expect(verdict("Read", { file_path: "\\\\server\\share\\x" })).toMatchObject({ verdict: "deny" });
  });

  it("ignores the letter case of a Windows path", () => {
    expect(verdict("Read", { file_path: "c:\\PROJ\\Src\\a.ts" })).toEqual({ verdict: "allow" });
  });

  it("honours extra folders", () => {
    const c = ctx({ folders: ["C:\\proj", "C:\\shared\\assets"] });
    expect(verdict("Read", { file_path: "C:\\shared\\assets\\logo.png" }, c)).toEqual({ verdict: "allow" });
    expect(verdict("Read", { file_path: "C:\\shared\\secrets.txt" }, c)).toMatchObject({ verdict: "deny" });
  });

  it("checks every field that can hold a path, not only file_path", () => {
    for (const field of ["path", "file_path", "notebook_path", "cwd"]) expect(verdict("Grep", { [field]: "C:\\Windows" }), field).toMatchObject({ verdict: "deny" });
    expect(verdict("Grep", { path: 5 })).toMatchObject({ verdict: "deny" });
  });

  it("refuses a path even when the tool is on the allow-list", () => {
    expect(verdict("Read", { file_path: "C:\\Windows\\win.ini" }, ctx({ policy: policy({ allowTools: ["Read"] }) }))).toMatchObject({ verdict: "deny" });
  });

  it("refuses every path when there are no folders at all, but leaves calls without a path to the allow-list", () => {
    const none = ctx({ folders: [], policy: policy({ allowTools: ["WebSearch"] }) });
    expect(verdict("Read", { file_path: "C:\\proj\\a" }, none)).toMatchObject({ verdict: "deny" });
    expect(verdict("WebSearch", { query: "x" }, none)).toEqual({ verdict: "allow" });
    expect(verdict("Task", {}, none)).toMatchObject({ verdict: "ask" });
  });
});

describe("shell commands", () => {
  it("a command from any shell tool is read the same way (PowerShell on Windows)", () => {
    const c = ctx({ policy: policy({ allowTools: ["PowerShell"], denyCommands: ["rm\\s+-rf", "git\\s+push"] }) });
    expect(verdict("PowerShell", { command: "git push origin main" }, c)).toMatchObject({ verdict: "deny" });
    expect(verdict("PowerShell", { command: "Get-ChildItem" }, c)).toEqual({ verdict: "allow" });
    expect(verdict("PowerShell", { command: "del x.txt" }, ctx({ shellPatterns: ["\\bdel\\b"] }))).toEqual({ verdict: "ask", danger: true });
  });

  it("ask by default, because Bash is not on the allow-list", () => {
    expect(verdict("Bash", { command: "npm install" })).toEqual({ verdict: "ask", danger: false });
  });

  it("are refused when they match a deny pattern, and the reason names the pattern", () => {
    const c = ctx({ policy: policy({ denyCommands: ["npm\\s+install"] }) });
    expect(verdict("Bash", { command: "NPM  install left-pad" }, c)).toMatchObject({ verdict: "deny", reason: expect.stringContaining("npm\\s+install") });
  });

  it("are still refused when Bash is on the allow-list", () => {
    const c = ctx({ policy: policy({ allowTools: ["Bash"], denyCommands: ["rm\\s+-rf"] }) });
    expect(verdict("Bash", { command: "rm -rf /" }, c)).toMatchObject({ verdict: "deny" });
    expect(verdict("Bash", { command: "ls" }, c)).toEqual({ verdict: "allow" });
  });

  it("do not fail on a deny pattern that is not a valid expression, and are not refused by it", () => {
    const c = ctx({ policy: policy({ denyCommands: ["(unclosed", "git\\s+push"] }) });
    expect(verdict("Bash", { command: "ls" }, c)).toEqual({ verdict: "ask", danger: false });
    expect(verdict("Bash", { command: "git push" }, c)).toMatchObject({ verdict: "deny" });
  });

  it("ask for the owner's PIN when the command matches one of Friend's dangerous-command patterns", () => {
    const c = ctx({ shellPatterns: ["\\bdel\\b"] });
    expect(verdict("Bash", { command: "del x.txt" }, c)).toEqual({ verdict: "ask", danger: true });
    expect(verdict("Bash", { command: "echo hi" }, c)).toEqual({ verdict: "ask", danger: false });
  });

  it("treat a command that is not text as asking, never as allowed", () => {
    const c = ctx({ policy: policy({ allowTools: [] }) });
    expect(verdict("Bash", { command: 5 }, c)).toEqual({ verdict: "ask", danger: false });
  });
});

describe("everything else", () => {
  it("follows the allow-list: allowed when listed, asked when not", () => {
    expect(verdict("WebSearch", { query: "x" }, ctx({ policy: policy({ allowTools: ["WebSearch"] }) }))).toEqual({ verdict: "allow" });
    expect(verdict("WebSearch", { query: "x" })).toEqual({ verdict: "ask", danger: false });
  });

  it("an empty allow-list asks about everything", () => {
    expect(verdict("Read", { file_path: "C:\\proj\\a" }, ctx({ policy: policy({ allowTools: [] }) }))).toEqual({ verdict: "ask", danger: false });
  });
});