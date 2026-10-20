import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerEvent } from "./events";
import { WorkerProc, buildWorkerArgs } from "./runner";

const FAKE = join(__dirname, "testing", "fake-claude.cjs");
const base = { model: "haiku", instructions: "Do the ticket.", permission: "default" as const, mcpConfigPath: "C:\\data\\mcp.json", extraFolders: [] as string[] };

describe("buildWorkerArgs", () => {
  it("builds exactly the flags a worker needs, with the owner's model and permission level", () => {
    expect(buildWorkerArgs({ ...base, sessionId: "s-1" })).toEqual([
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", "haiku",
      "--permission-mode", "default",
      "--setting-sources", "local",
      "--strict-mcp-config", "--mcp-config", "C:\\data\\mcp.json",
      "--permission-prompt-tool", "mcp__office__approve",
      "--disable-slash-commands",
      "--append-system-prompt", "Do the ticket.",
      "--session-id", "s-1",
    ]);
  });

  it("leaves out the system prompt when there are no instructions, and resumes a session when it has one", () => {
    const a = buildWorkerArgs({ ...base, instructions: "  ", resume: "s-9" });
    expect(a).not.toContain("--append-system-prompt");
    expect(a.slice(-2)).toEqual(["--resume", "s-9"]);
    expect(a).not.toContain("--session-id");
  });

  it("repeats --add-dir for each extra folder, and uses the permission level it was given", () => {
    const a = buildWorkerArgs({ ...base, permission: "acceptEdits", extraFolders: ["C:\\a", "C:\\b"], sessionId: "s" });
    expect(a.filter((x) => x === "--add-dir")).toHaveLength(2);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(a).toContain("C:\\b");
  });

  it("puts the program's own leading arguments first", () => {
    expect(buildWorkerArgs({ ...base, sessionId: "s", commandArgs: ["--debug"] })[0]).toBe("--debug");
  });

  it("never asks Claude Code to skip its questions or to allow tools by itself, whatever it is given", () => {
    const tricky = [
      { ...base, sessionId: "s" },
      { ...base, instructions: "--allowedTools Bash", sessionId: "s" },
      { ...base, instructions: "--dangerously-skip-permissions", extraFolders: ["--allowedTools"], sessionId: "s" },
      { ...base, model: "--dangerously-skip-permissions", sessionId: "s" },
      { ...base, permission: "acceptEdits" as const, resume: "r" },
    ];
    for (const o of tricky) {
      const a = buildWorkerArgs(o);
      expect(a, JSON.stringify(o)).not.toContain("--allowedTools");
      expect(a).not.toContain("--dangerously-skip-permissions");
      expect(a).not.toContain("--allow-dangerously-skip-permissions");
      expect(a).not.toContain("bypassPermissions");
    }
  });

  it("does not let a value that starts with a dash be read as a flag", () => {
    const a = buildWorkerArgs({ ...base, instructions: "--allowedTools Bash", model: "--oops", extraFolders: ["--x", "C:\\ok"], sessionId: "s" });
    expect(a).not.toContain("--oops");
    expect(a).not.toContain("--x");
    expect(a).toContain("C:\\ok");
    expect(a[a.indexOf("--append-system-prompt") + 1]).not.toMatch(/^-/);
  });
});

const procs: WorkerProc[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill();
});
const start = (env: Record<string, string> = {}, command = process.execPath) => {
  const events: WorkerEvent[] = [];
  let exit: { code: number | null; stderr: string; notInstalled: boolean } | null = null;
  const proc = new WorkerProc({ command, args: [FAKE], cwd: tmpdir(), env: { ...process.env, ...env } }, (e) => events.push(e), (x) => (exit = x));
  procs.push(proc);
  return { proc, events, exit: () => exit };
};

describe("WorkerProc", () => {
  it("relays a whole session as parsed events, in order, and reports a clean exit", async () => {
    const { proc, events, exit } = start();
    proc.send("do it");
    await proc.exited;
    expect(events[0]!.kind).toBe("init");
    expect(events.at(-1)!.kind).toBe("result");
    expect(events.filter((e) => e.kind === "tool").map((e) => (e as { name: string }).name)).toEqual(["Write", "Bash"]);
    expect(exit()).toMatchObject({ code: 0, notInstalled: false });
    expect(proc.alive).toBe(false);
    proc.send("again"); // after the end, nothing happens and nothing throws
  });

  it("is started with the arguments it was given", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "friend-fake-")), "args.json");
    const { proc } = start({ FAKE_ARGS_OUT: out });
    proc.send("go");
    await proc.exited;
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([]);
  });

  it("can be stopped while it waits, and stopping twice is harmless", async () => {
    const { proc, exit } = start({ FAKE_HANG: "1" });
    proc.send("go");
    await new Promise((r) => setTimeout(r, 300));
    expect(proc.alive).toBe(true);
    proc.kill();
    await proc.exited;
    expect(proc.alive).toBe(false);
    expect(exit()).not.toBeNull();
    proc.kill();
  });

  it("says when the program is not installed", async () => {
    const { proc, exit } = start({}, "friend-no-such-program-xyz");
    await proc.exited;
    expect(exit()).toMatchObject({ notInstalled: true });
  });
});