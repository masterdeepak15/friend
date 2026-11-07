import { describe, expect, it } from "vitest";
import { CodeBox, MAX_CODE_CHARS, type DockerExec } from "./codebox";
import type { CodeRunnerMode } from "./config";
import { SandboxUnavailable, type SandboxInput, type SandboxResult } from "./sandbox";

const sandboxOk = (over: Partial<SandboxResult> = {}): SandboxResult => ({ code: 0, stdout: "from sandbox\n", stderr: "", timedOut: false, outOfMemory: false, ...over });

function rig(mode: CodeRunnerMode, docker: "works" | "missing" | "stopped" | "cannot-start", sandbox: (i: SandboxInput) => Promise<SandboxResult> = async () => sandboxOk()) {
  const calls = { docker: 0, sandbox: 0, last: undefined as SandboxInput | undefined };
  let now = 1_000_000;
  const exec: DockerExec = async () => {
    calls.docker++;
    if (docker === "missing") throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    if (docker === "stopped") return { code: 125, stdout: "", stderr: "Cannot connect to the Docker daemon at npipe://...", timedOut: false };
    if (docker === "cannot-start") return { code: 125, stdout: "", stderr: "pull access denied", timedOut: false };
    return { code: 0, stdout: "from docker\n", stderr: "", timedOut: false };
  };
  const box = new CodeBox(exec, {
    mode: () => mode,
    sandbox: async (i) => {
      calls.sandbox++;
      calls.last = i;
      return sandbox(i);
    },
    now: () => now,
  });
  return { box, calls, advance: (ms: number) => (now += ms) };
}
const py = { language: "python" as const, code: "print(1)" };

describe("CodeBox picks where the code runs", () => {
  it("docker mode: Docker only, with Docker's own messages when it is missing", async () => {
    const r = rig("docker", "missing");
    expect(await r.box.run(py)).toEqual({ ok: false, error: "Docker is not available. Install Docker Desktop and start it to run code safely." });
    expect(r.calls.sandbox).toBe(0);
  });

  it("sandbox mode: never asks Docker", async () => {
    const r = rig("sandbox", "works");
    const out = await r.box.run(py);
    expect(out).toMatchObject({ ok: true, runner: "sandbox", stdout: "from sandbox\n", exitCode: 0 });
    expect(r.calls.docker).toBe(0);
  });

  it("auto: uses Docker when it works, and never the sandbox", async () => {
    const r = rig("auto", "works");
    expect(await r.box.run(py)).toMatchObject({ ok: true, runner: "docker", stdout: "from docker\n" });
    expect(r.calls.sandbox).toBe(0);
  });

  it.each([["missing"], ["stopped"], ["cannot-start"]] as const)("auto: Docker %s, so the sandbox runs it", async (state) => {
    const r = rig("auto", state);
    expect(await r.box.run(py)).toMatchObject({ ok: true, runner: "sandbox", stdout: "from sandbox\n" });
    expect(r.calls.sandbox).toBe(1);
  });

  it("tells the caller when auto had to use the sandbox because Docker would not run it, and only then", async () => {
    expect(await rig("auto", "missing").box.run(py)).toMatchObject({ runner: "sandbox", fellBack: true });
    expect(await rig("sandbox", "works").box.run(py)).not.toHaveProperty("fellBack");
    expect(await rig("auto", "works").box.run(py)).not.toHaveProperty("fellBack");
  });

  it("auto: after Docker failed, it is not tried again for a minute, then it is", async () => {
    const r = rig("auto", "missing");
    await r.box.run(py);
    await r.box.run(py);
    expect(r.calls.docker).toBe(1);
    r.advance(61_000);
    await r.box.run(py);
    expect(r.calls.docker).toBe(2);
  });

  it("refuses bad input the same way in every mode, before any backend", async () => {
    for (const mode of ["auto", "sandbox", "docker"] as const) {
      const r = rig(mode, "works");
      expect(await r.box.run({ language: "python", code: "  " })).toEqual({ ok: false, error: "There is no code to run." });
      expect((await r.box.run({ language: "python", code: "x".repeat(MAX_CODE_CHARS + 1) })).ok).toBe(false);
      expect(await r.box.run({ ...py, files: { "../evil": "x" } })).toEqual({ ok: false, error: "That file name is not allowed in the sandbox." });
      expect(r.calls.docker + r.calls.sandbox).toBe(0);
    }
  });

  it("passes the files and the time limit to the sandbox", async () => {
    const r = rig("sandbox", "works");
    await r.box.run({ ...py, timeoutSec: 5, files: { "a.txt": "x" } });
    expect(r.calls.last).toMatchObject({ language: "python", code: "print(1)", files: { "a.txt": "x" }, timeoutMs: 5000 });
  });

  it("says plainly when the program ran out of memory or ran out of time", async () => {
    const mem = await rig("sandbox", "works", async () => sandboxOk({ code: null, stdout: "", outOfMemory: true })).box.run(py);
    expect(mem).toMatchObject({ ok: true, runner: "sandbox" });
    expect((mem as { stderr: string }).stderr).toContain("ran out of memory (limit 512 MB)");
    const slow = await rig("sandbox", "works", async () => sandboxOk({ code: null, timedOut: true })).box.run(py);
    expect(slow).toMatchObject({ ok: true, timedOut: true });
  });

  it("turns a sandbox that cannot start into a plain error", async () => {
    const r = rig("sandbox", "works", async () => {
      throw new SandboxUnavailable("The built-in sandbox could not start: no.");
    });
    expect(await r.box.run(py)).toEqual({ ok: false, error: "The built-in sandbox could not start: no." });
  });
});
