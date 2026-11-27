import { NO_PC_PERMISSIONS, type PcPermissions } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { checkPcCall, insideFolders } from "./guard";

const perms = (over: Partial<PcPermissions> = {}): PcPermissions => ({ ...NO_PC_PERMISSIONS, ...over });
const session = { lease: true };
const none = { lease: false };
const check = (tool: string, args: object, p: PcPermissions, state = session) => checkPcCall(tool, args, p, state, []);

describe("what the assistant may do on a PC, before anything is sent", () => {
  it("refuses every kind of thing a PC has not been given, and says what to change", () => {
    for (const [tool, args] of [["pc.shell", { command: "dir" }], ["pc.files", { action: "read", path: "D:\\a.txt" }], ["pc.process", { action: "list" }], ["pc.registry", { action: "read", key: "HKCU:\\x" }], ["pc.term.open", { cwd: "D:\\shop" }], ["pc.click", { label: 1 }], ["pc.snapshot", {}]] as const) {
      const r = check(tool, args, perms());
      expect(r.decision, tool).toBe("deny");
      expect(r.reason, tool).toMatch(/permission|Settings|not allowed/i);
    }
  });

  it("needs a control session to look at the screen and to use the mouse and keyboard", () => {
    const p = perms({ control: true, screen: true });
    for (const [tool, args] of [["pc.click", { label: 1 }], ["pc.type", { text: "x" }], ["pc.snapshot", {}], ["pc.screenshot", {}], ["pc.shortcut", { keys: "ctrl+c" }], ["pc.app", { action: "launch", name: "Notepad" }]] as const) {
      expect(check(tool, args, p, none).decision, tool).toBe("deny");
      expect(check(tool, args, p, none).reason, tool).toMatch(/control session/i);
      expect(check(tool, args, p, session).decision, tool).toBe("allow");
    }
    expect(check("pc.snapshot", {}, perms({ control: true }), session).decision).toBe("deny"); // the screen switch is its own
    expect(check("pc.displays", {}, perms(), none).decision).toBe("allow");
    expect(check("pc.wait", { seconds: 2 }, perms(), none).decision).toBe("allow"); // waiting needs no session
  });

  it("asks before starting a control session, and only when the PC allows control", () => {
    expect(check("pc.control", { action: "start" }, perms({ control: true }), none).decision).toBe("ask");
    expect(check("pc.control", { action: "start" }, perms(), none).decision).toBe("deny");
    expect(check("pc.control", { action: "stop" }, perms(), none).decision).toBe("allow");
    expect(check("pc.control", { action: "status" }, perms(), none).decision).toBe("allow");
  });

  it("keeps files and terminals inside the allowed folders, and refuses (never asks) outside them", () => {
    const p = perms({ files: "write", shell: true, folders: ["D:\\shop"] });
    expect(check("pc.files", { action: "read", path: "D:\\shop\\src\\a.ts" }, p).decision).toBe("allow");
    expect(check("pc.files", { action: "read", path: "d:/SHOP/readme.md" }, p).decision).toBe("allow");
    expect(check("pc.files", { action: "read", path: "D:\\shop\\..\\secrets\\x" }, p).decision).toBe("deny");
    expect(check("pc.files", { action: "read", path: "D:\\shopping\\x" }, p).decision).toBe("deny");
    expect(check("pc.files", { action: "copy", path: "D:\\shop\\a", to: "C:\\out" }, p).decision).toBe("deny");
    expect(check("pc.term.open", { cwd: "D:\\shop" }, p).decision).toBe("ask");
    expect(check("pc.term.open", { cwd: "C:\\Windows" }, p).decision).toBe("deny");
    expect(check("pc.term.open", {}, p).decision).toBe("deny");
    expect(check("pc.files", { action: "read", path: "D:\\shop\\a" }, perms({ files: "read" })).decision).toBe("deny"); // no folders chosen
  });

  it("lets files be read with read access but not written", () => {
    const p = perms({ files: "read", folders: ["D:\\shop"] });
    expect(check("pc.files", { action: "list", path: "D:\\shop" }, p).decision).toBe("allow");
    expect(check("pc.files", { action: "write", path: "D:\\shop\\a.txt", content: "x" }, p).decision).toBe("deny");
  });

  it("asks for what cannot be undone: deleting, ending processes, registry writes, programs and destructive shell commands", () => {
    const p = perms({ files: "write", folders: ["D:\\shop"], shell: true, registry: true, process: true });
    expect(check("pc.files", { action: "delete", path: "D:\\shop\\a.txt" }, p).decision).toBe("ask");
    expect(check("pc.files", { action: "write", path: "D:\\shop\\run.ps1", content: "x" }, p).decision).toBe("ask");
    expect(check("pc.files", { action: "write", path: "D:\\shop\\a.txt", content: "x" }, p).decision).toBe("allow");
    expect(check("pc.process", { action: "end", name: "notepad" }, p).decision).toBe("ask");
    expect(check("pc.process", { action: "list" }, p).decision).toBe("allow");
    expect(check("pc.registry", { action: "write", key: "HKCU:\\x", name: "a", value: "1" }, p).decision).toBe("ask");
    expect(check("pc.registry", { action: "read", key: "HKCU:\\x" }, p).decision).toBe("allow");
    expect(check("pc.shell", { command: "Remove-Item -Recurse -Force D:\\shop" }, p).decision).toBe("ask");
    expect(check("pc.shell", { command: "Get-ChildItem D:\\shop" }, p).decision).toBe("allow");
  });

  it("adds the owner's own patterns to the list that asks", () => {
    const p = perms({ shell: true });
    expect(checkPcCall("pc.shell", { command: "git push origin main" }, p, session, []).decision).toBe("allow");
    expect(checkPcCall("pc.shell", { command: "git push origin main" }, p, session, ["git push"]).decision).toBe("ask");
  });
});

describe("is a path inside the allowed folders", () => {
  it("ignores case and slash direction, refuses climbing out and look-alike names, and says no when no folder is allowed", () => {
    expect(insideFolders("d:/shop/a", ["D:\\Shop"])).toBe(true);
    expect(insideFolders("D:\\shop", ["D:\\shop"])).toBe(true);
    expect(insideFolders("D:\\shop\\..\\x", ["D:\\shop"])).toBe(false);
    expect(insideFolders("D:\\shop2", ["D:\\shop"])).toBe(false);
    expect(insideFolders("D:\\shop", [])).toBe(false);
    expect(insideFolders("relative\\path", ["D:\\shop"])).toBe(false);
  });
});
