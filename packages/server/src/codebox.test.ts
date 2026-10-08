import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodeBox, MAX_CODE_CHARS, MAX_OUTPUT_CHARS, type DockerExec, type DockerResult } from "./codebox";

/** A fake docker that records what it was asked to run. */
function fakeDocker(result: Partial<DockerResult> = {}) {
  const calls: { args: string[]; timeoutMs: number; source?: string }[] = [];
  const exec: DockerExec = async (args, opts) => {
    // the code file is visible to the container only while docker runs: capture it now
    const mount = args[args.indexOf("-v") + 1]!;
    const dir = mount.slice(0, mount.lastIndexOf(":/work:ro"));
    const files = ["main.py", "main.js", "main.sh"].map((f) => `${dir}/${f}`).filter(existsSync);
    calls.push({ args, timeoutMs: opts.timeoutMs, source: files[0] ? readFileSync(files[0], "utf8") : undefined });
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
  return { exec, calls };
}
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("CodeBox.run: what the container is allowed to do", () => {
  it("runs with no network, a read-only root, no capabilities, small limits and an unprivileged user", async () => {
    const d = fakeDocker({ stdout: "hi\n" });
    const out = await new CodeBox(d.exec).run({ language: "python", code: "print('hi')" });
    const a = d.calls[0]!.args;
    expect(a.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(flag(a, "--network")).toBe("none");
    expect(a).toContain("--read-only");
    expect(flag(a, "--cap-drop")).toBe("ALL");
    expect(flag(a, "--security-opt")).toBe("no-new-privileges");
    expect(flag(a, "--memory")).toBe("512m");
    expect(flag(a, "--memory-swap")).toBe("512m");
    expect(flag(a, "--cpus")).toBe("1");
    expect(flag(a, "--pids-limit")).toBe("128");
    expect(flag(a, "--user")).toBe("65534:65534");
    expect(flag(a, "--tmpfs")).toMatch(/^\/tmp:.*size=64m/);
    expect(out).toMatchObject({ ok: true, stdout: "hi\n", exitCode: 0 });
  });

  it("mounts only the code, read-only, and never anything from the owner's PC", async () => {
    const d = fakeDocker();
    await new CodeBox(d.exec).run({ language: "python", code: "print(1)" });
    const a = d.calls[0]!.args;
    const mounts = a.flatMap((x, i) => (x === "-v" ? [a[i + 1]!] : []));
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toMatch(/:\/work:ro$/);
    expect(a).not.toContain("--privileged");
    expect(a.join(" ")).not.toMatch(/docker\.sock|--pid[= ]|--ipc|--net(work)?[= ]host|--device/);
    expect(d.calls[0]!.source).toBe("print(1)");
  });

  it.each([
    ["python", "python:3.12-alpine", "main.py", ["python", "-I"]],
    ["node", "node:22-alpine", "main.js", ["node"]],
    ["shell", "alpine:3.20", "main.sh", ["sh"]],
  ] as const)("runs %s in %s", async (language, image, file, runner) => {
    const d = fakeDocker();
    await new CodeBox(d.exec).run({ language, code: "x" });
    const a = d.calls[0]!.args;
    const at = a.indexOf(image);
    expect(at).toBeGreaterThan(-1);
    expect(a.slice(at + 1)).toEqual([...runner, `/work/${file}`]);
  });

  it("gives each run its own container name, so a timeout can stop exactly that one", async () => {
    const d = fakeDocker();
    const box = new CodeBox(d.exec);
    await box.run({ language: "python", code: "1" });
    await box.run({ language: "python", code: "2" });
    const names = d.calls.map((c) => flag(c.args, "--name")!);
    expect(names[0]).toMatch(/^friend-run-[0-9a-f-]{36}$/);
    expect(names[0]).not.toBe(names[1]);
  });
});

describe("CodeBox.run: results", () => {
  it("reports a failing program with its error output", async () => {
    const d = fakeDocker({ code: 1, stderr: "Traceback...\nZeroDivisionError" });
    const out = await new CodeBox(d.exec).run({ language: "python", code: "1/0" });
    expect(out).toMatchObject({ ok: true, exitCode: 1 });
    expect(out.ok && out.stderr).toContain("ZeroDivisionError");
  });

  it("cuts very long output and says so", async () => {
    const d = fakeDocker({ stdout: "x".repeat(MAX_OUTPUT_CHARS * 3) });
    const out = await new CodeBox(d.exec).run({ language: "python", code: "1" });
    expect(out.ok && out.stdout.length).toBeLessThan(MAX_OUTPUT_CHARS + 100);
    expect(out.ok && out.stdout).toContain("[output cut]");
  });

  it("reports a timeout, and passes the limit through (default 10 s, at most 60 s)", async () => {
    const d = fakeDocker({ timedOut: true, code: 137 });
    const box = new CodeBox(d.exec);
    const out = await box.run({ language: "python", code: "while True: pass", timeoutSec: 600 });
    expect(out).toMatchObject({ ok: true, timedOut: true });
    expect(d.calls[0]!.timeoutMs).toBe(60_000);
    await box.run({ language: "python", code: "1" });
    expect(d.calls[1]!.timeoutMs).toBe(10_000);
    await box.run({ language: "python", code: "1", timeoutSec: 0 });
    expect(d.calls[2]!.timeoutMs).toBe(10_000);
  });

  it("refuses empty or oversize code without starting docker", async () => {
    const d = fakeDocker();
    const box = new CodeBox(d.exec);
    expect(await box.run({ language: "python", code: "  " })).toEqual({ ok: false, error: "There is no code to run." });
    expect(await box.run({ language: "python", code: "x".repeat(MAX_CODE_CHARS + 1) })).toEqual({
      ok: false,
      error: `The code is too long (the limit is ${MAX_CODE_CHARS} characters).`,
    });
    expect(d.calls).toHaveLength(0);
  });

  it("explains when docker is not installed or not running, without leaking details", async () => {
    const box = new CodeBox(async () => {
      throw Object.assign(new Error("spawn docker ENOENT C:\\secret\\path"), { code: "ENOENT" });
    });
    const out = await box.run({ language: "python", code: "1" });
    expect(out).toEqual({ ok: false, error: "Docker is not available. Install Docker Desktop and start it to run code safely." });
    const down = await new CodeBox(async () => ({ code: 125, stdout: "", stderr: "Cannot connect to the Docker daemon at npipe://...", timedOut: false })).run({
      language: "python",
      code: "1",
    });
    expect(down).toEqual({ ok: false, error: "Docker is not running. Start Docker Desktop and try again." });
  });

  it("removes the temporary code folder afterwards", async () => {
    const d = fakeDocker();
    await new CodeBox(d.exec).run({ language: "python", code: "1" });
    const mount = d.calls[0]!.args[d.calls[0]!.args.indexOf("-v") + 1]!;
    expect(existsSync(mount.slice(0, mount.lastIndexOf(":/work:ro")))).toBe(false);
  });
});
