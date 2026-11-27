import { describe, expect, it } from "vitest";
import { NO_PC_PERMISSIONS, PC_TOOL_NAMES, PcDown, PcPermissions, PcStatus, PcUp, TOOL_DEFS, describeCall } from "./index";

const def = (n: string) => TOOL_DEFS.find((t) => t.name === n)!;

describe("the PC tools", () => {
  it("has a gateway tool for everything the assistant does on a PC, each with an optional pc name", () => {
    expect(PC_TOOL_NAMES.length).toBeGreaterThan(25);
    for (const n of PC_TOOL_NAMES) {
      const d = def(n);
      expect(d, n).toBeTruthy();
      expect(d.target, n).toBe("gateway");
      expect(d.input.safeParse(minimal(n)).success, `${n} accepts ${JSON.stringify(minimal(n))}`).toBe(true);
    }
    for (const n of ["pc.list", "pc.displays", "pc.term.list"]) expect(def(n).readOnly, n).toBe(true);
  });

  it("never lets the input tools through as plain reads, and asks for what runs, writes or ends things", () => {
    for (const n of ["pc.click", "pc.type", "pc.scroll", "pc.move", "pc.shortcut", "pc.app", "pc.clipboard", "pc.term.send"]) expect(def(n).baseTier, n).not.toBe("T0");
    for (const n of ["pc.shell", "pc.files", "pc.process", "pc.registry", "pc.term.open"]) expect(["T2", "T3"], n).toContain(def(n).baseTier);
  });

  it("checks the arguments: a click needs an element number or a place, a key action is known, a spoken wait is bounded", () => {
    expect(def("pc.click").input.safeParse({ pc: "Office" }).success).toBe(false);
    expect(def("pc.click").input.safeParse({ label: 12 }).success).toBe(true);
    expect(def("pc.click").input.safeParse({ x: 10, y: 20, button: "right", clicks: 2 }).success).toBe(true);
    expect(def("pc.click").input.safeParse({ x: 10 }).success).toBe(false);
    expect(def("pc.control").input.safeParse({ action: "dance" }).success).toBe(false);
    expect(def("pc.wait").input.safeParse({ seconds: 9999 }).success).toBe(false);
    expect(def("pc.term.send").input.safeParse({ id: "t1", text: "fix the tests", enter: true }).success).toBe(true);
    expect(def("pc.term.send").input.safeParse({ id: "t1", keys: ["Down", "Enter"] }).success).toBe(true);
    expect(def("pc.term.send").input.safeParse({ id: "t1" }).success).toBe(false);
  });

  it("names the PC on an approval card", () => {
    expect(describeCall("pc.shell", { pc: "Office", command: "dir" })).toMatch(/Office/);
    expect(describeCall("pc.click", { pc: "Office", label: 4 })).toMatch(/Office/);
    expect(describeCall("pc.term.open", { pc: "Office", cwd: "D:\\shop", command: "claude" })).toMatch(/claude/);
  });
});

describe("what a PC may do and how it talks to Friend", () => {
  it("starts with everything off", () => {
    expect(PcPermissions.parse(NO_PC_PERMISSIONS)).toEqual({ control: false, screen: false, shell: false, registry: false, process: false, files: "off", folders: [] });
  });

  it("accepts the messages of the link and refuses others", () => {
    expect(PcUp.safeParse({ type: "hello", os: "Windows 11", host: "OFFICE-PC", version: "0.1.97" }).success).toBe(true);
    expect(PcUp.safeParse({ type: "tool.result", id: "1", result: { output: "ok", truncated: false } }).success).toBe(true);
    expect(PcUp.safeParse({ type: "status", status: { state: "idle", at: 1 } }).success).toBe(true);
    expect(PcUp.safeParse({ type: "status", status: { state: "flying", at: 1 } }).success).toBe(false);
    expect(PcUp.safeParse({ type: "nope" }).success).toBe(false);
    expect(PcDown.safeParse({ type: "tool.exec", id: "1", tool: "pc.click", args: { label: 3 } }).success).toBe(true);
    expect(PcDown.safeParse({ type: "lease.start", id: "l1", minutes: 30 }).success).toBe(true);
    expect(PcDown.safeParse({ type: "revoke" }).success).toBe(true);
    expect(PcDown.safeParse({ type: "update", url: "/api/pc/agent.js", sha256: "a".repeat(64) }).success).toBe(true);
    expect(PcStatus.safeParse({ state: "controlling", task: "update the report", at: 5, sessions: 1 }).success).toBe(true);
  });
});

/** The smallest valid arguments for each tool. */
function minimal(n: string): Record<string, unknown> {
  const by: Record<string, Record<string, unknown>> = {
    "pc.control": { action: "start" },
    "pc.tasks": { action: "list" },
    "pc.click": { label: 1 },
    "pc.type": { text: "hi", label: 2 },
    "pc.scroll": { direction: "down" },
    "pc.move": { x: 1, y: 2 },
    "pc.shortcut": { keys: "ctrl+c" },
    "pc.multi_select": { labels: [1, 2] },
    "pc.multi_edit": { edits: [{ label: 1, text: "a" }] },
    "pc.app": { action: "launch", name: "Notepad" },
    "pc.clipboard": { action: "get" },
    "pc.wait": { seconds: 1 },
    "pc.wait_for": { condition: "text_exists", text: "Done" },
    "pc.shell": { command: "dir" },
    "pc.files": { action: "list", path: "D:\\" },
    "pc.process": { action: "list" },
    "pc.registry": { action: "read", key: "HKCU:\\Software" },
    "pc.notify": { title: "t", message: "m" },
    "pc.term.open": { cwd: "D:\\shop", command: "claude" },
    "pc.term.read": { id: "t1" },
    "pc.term.send": { id: "t1", text: "hi" },
    "pc.term.wait": { id: "t1" },
    "pc.term.close": { id: "t1" },
    "pc.claude.sessions": { project: "D:\\shop" },
  };
  return by[n] ?? {};
}
