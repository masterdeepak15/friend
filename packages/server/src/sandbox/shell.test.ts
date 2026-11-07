import { describe, expect, it } from "vitest";
import { runInSandbox } from "./index";

const sh = (code: string, over: { files?: Record<string, string>; timeoutMs?: number } = {}) =>
  runInSandbox({ language: "shell", code, files: over.files ?? {}, timeoutMs: over.timeoutMs ?? 10_000 });

describe("shell scripts in the built-in sandbox", () => {
  it("runs pipes", async () => {
    expect(await sh("echo hi | tr a-z A-Z")).toMatchObject({ code: 0, stdout: "HI\n" });
  });

  it("lists and reads the files it was given", async () => {
    const r = await sh("ls\ncat data.txt | wc -l", { files: { "data.txt": "a\nb\nc\n" } });
    expect(r.stdout).toContain("data.txt");
    expect(r.stdout.trim().split("\n").pop()?.trim()).toBe("3");
  });

  it("keeps the exit code", async () => {
    expect((await sh("exit 3")).code).toBe(3);
  });

  it("names a command it does not have, in plain words", async () => {
    const r = await sh("curl http://example.com");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("curl");
    expect(r.stderr).toContain("built-in sandbox");
  });

  it("finds nothing of the real computer", async () => {
    const r = await sh("cat /etc/passwd; cat ../../config.json; ls /Users /home 2>&1; echo $HOME; env | grep -i -E 'key|token|secret'");
    expect(r.stdout).not.toMatch(/root:|DEEPAK|config/);
  });

  it("is stopped when it never ends", async () => {
    const t = Date.now();
    const r = await sh("while true; do :; done", { timeoutMs: 1000 });
    expect(r.timedOut || r.code !== 0).toBe(true);
    expect(Date.now() - t).toBeLessThan(15_000);
  }, 30_000);
});
