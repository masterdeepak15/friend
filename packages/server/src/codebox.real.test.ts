/**
 * Real containers: the walls are checked by running hostile code, not by reading the command line.
 * Skipped, with the reason shown, when Docker is not running or an image has not been downloaded.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodeBox } from "./codebox";

function dockerHas(image: string): boolean {
  try {
    return execFileSync("docker", ["image", "inspect", image, "--format", "{{.Id}}"], { stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).length > 0;
  } catch {
    return false;
  }
}
const ready = dockerHas("python:3.12-alpine") && dockerHas("node:22-alpine") && dockerHas("alpine:3.20");
const box = new CodeBox();
const py = async (code: string, timeoutSec = 20) => {
  const r = await box.run({ language: "python", code, timeoutSec });
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe.skipIf(!ready)("real containers", () => {
  it("runs a program and returns its output and exit code", async () => {
    expect(await py("print('hello from the box')")).toMatchObject({ exitCode: 0, stdout: "hello from the box\n", timedOut: false });
    const bad = await py("import sys; print('oops', file=sys.stderr); sys.exit(3)");
    expect(bad).toMatchObject({ exitCode: 3 });
    expect(bad.stderr).toContain("oops");
  }, 60_000);

  it("has no network at all", async () => {
    const r = await py(`
import socket
try:
    socket.create_connection(("1.1.1.1", 80), timeout=3)
    print("REACHED")
except OSError:
    print("blocked")
try:
    socket.getaddrinfo("example.com", 80)
    print("DNS REACHED")
except OSError:
    print("dns blocked")
`);
    expect(r.stdout).toBe("blocked\ndns blocked\n");
  }, 60_000);

  it("cannot write outside /tmp, and cannot change its own code", async () => {
    const r = await py(`
import os
def attempt(path):
    try:
        open(path, "w").write("x"); return "WROTE"
    except OSError:
        return "denied"
print(attempt("/etc/evil"), attempt("/work/main.py"), attempt("/work/new.txt"), attempt("/usr/bin/evil"))
open("/tmp/ok", "w").write("fine"); print(open("/tmp/ok").read())
`);
    expect(r.stdout).toBe("denied denied denied denied\nfine\n");
  }, 60_000);

  it("sees nothing of the owner's PC: only its own code is in /work, and it is not root", async () => {
    const r = await py(`
import os
print(sorted(os.listdir("/work")))
print(os.getuid(), os.getgid())
print([p for p in ("/mnt/c", "/c", "/Users", "/host_mnt", "/var/run/docker.sock") if os.path.exists(p)])
`);
    expect(r.stdout).toBe("['main.py']\n65534 65534\n[]\n");
  }, 60_000);

  it("is stopped when it uses too much memory", async () => {
    const r = await py("x = bytearray(1500 * 1024 * 1024); x[::4096] = b'1' * len(x[::4096]); print('SURVIVED')");
    expect(r.stdout).not.toContain("SURVIVED");
    expect(r.exitCode).not.toBe(0);
  }, 90_000);

  it("stops an endless loop at the time limit and leaves no container behind", async () => {
    const started = Date.now();
    const r = await box.run({ language: "python", code: "while True: pass", timeoutSec: 2 });
    expect(r).toMatchObject({ ok: true, timedOut: true });
    expect(Date.now() - started).toBeLessThan(20_000);
    await new Promise((res) => setTimeout(res, 1500));
    const left = execFileSync("docker", ["ps", "-a", "--filter", "name=friend-run-", "--format", "{{.Names}}"], { encoding: "utf8" }).trim();
    expect(left).toBe("");
  }, 60_000);

  it("leaves nothing behind even when the time runs out while docker is still starting the container", async () => {
    // a 1 second limit often fires before the container has started: it must still be removed
    for (let i = 0; i < 4; i++) await box.run({ language: "python", code: "import time; time.sleep(30)", timeoutSec: 1 });
    await new Promise((res) => setTimeout(res, 2500));
    const left = execFileSync("docker", ["ps", "-a", "--filter", "name=friend-run-", "--format", "{{.Names}} {{.Status}}"], { encoding: "utf8" }).trim();
    expect(left).toBe("");
  }, 120_000);

  it("limits a fork bomb", async () => {
    const r = await py(`
import os
n = 0
try:
    for _ in range(2000):
        if os.fork() == 0:
            import time; time.sleep(5); os._exit(0)
        n += 1
except OSError:
    pass
print("limited" if n < 500 else "UNLIMITED")
`);
    expect(r.stdout).toContain("limited");
  }, 90_000);

  it("runs node and shell too", async () => {
    const n = await box.run({ language: "node", code: "console.log(1 + 2)" });
    expect(n).toMatchObject({ ok: true, stdout: "3\n" });
    const s = await box.run({ language: "shell", code: "echo $((6 * 7)); id -u" });
    expect(s).toMatchObject({ ok: true, stdout: "42\n65534\n" });
  }, 90_000);
});
