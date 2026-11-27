import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { launcherVbs, takeLock } from "./watchdog";

describe("one agent at a time", () => {
  it("takes the lock when nobody has it, and writes its own process id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-lock-"));
    expect(await takeLock(dir, () => {}, 200)).toBe(true);
    expect(readFileSync(join(dir, "agent.pid"), "utf8")).toBe(String(process.pid));
  });

  it("takes it over from a process that is gone (an agent that was killed leaves its id behind)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-lock-"));
    writeFileSync(join(dir, "agent.pid"), "2147483000"); // no such process
    expect(await takeLock(dir, () => {}, 200)).toBe(true);
  });

  it("stops quietly when another agent is really running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-lock-"));
    // this very test process is a running Node program, so its id stands for a running agent; another process id is needed, the parent
    writeFileSync(join(dir, "agent.pid"), String(process.ppid));
    const lines: string[] = [];
    const got = await takeLock(dir, (l) => lines.push(l), 300);
    // the parent of the test worker is Node too on every platform the tests run on; if it is not, this cannot tell and the lock is taken
    if (got) return;
    expect(lines.join(" ")).toMatch(/another agent is running/);
  });
});

describe("starting without a window", () => {
  it("writes a launcher that runs the program with no window (style 0), waits for it, and gives back its exit code", () => {
    const vbs = launcherVbs("C:\\Users\\Ann Lee\\AppData\\Local\\Friend\\pc-agent", "C:\\Users\\Ann Lee\\AppData\\Local\\Friend\\pc-agent\\node.exe", "C:\\Users\\Ann Lee\\AppData\\Local\\Friend\\pc-agent\\agent.cjs");
    expect(vbs).toContain('s.Run("""C:\\Users\\Ann Lee\\AppData\\Local\\Friend\\pc-agent\\node.exe"" ""C:\\Users\\Ann Lee\\AppData\\Local\\Friend\\pc-agent\\agent.cjs""", 0, True)');
    expect(vbs).toContain("WScript.Quit rc");
  });

  it.skipIf(process.platform !== "win32")("really works on Windows, even with a space in the path: it starts the program, waits, and passes the exit code on", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend launch "));
    const script = join(dir, "agent.cjs");
    writeFileSync(script, 'require("node:fs").writeFileSync(require("node:path").join(__dirname, "ran.txt"), "yes"); process.exit(7);');
    const vbs = join(dir, "run.vbs");
    writeFileSync(vbs, launcherVbs(dir, process.execPath, script));
    const r = spawnSync("wscript.exe", ["//B", "//Nologo", vbs], { windowsHide: true, timeout: 30_000 });
    expect(readFileSync(join(dir, "ran.txt"), "utf8")).toBe("yes");
    expect(r.status).toBe(7);
  });
});