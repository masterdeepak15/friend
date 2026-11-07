import { createServer, type Server } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInSandbox, type SandboxLanguage } from "./index";

// A real data folder with secrets in it, a secret in this process's environment, and a local server that counts connections.
let dir = "";
let secretPath = "";
let server: Server;
let port = 0;
let connections = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "friend-escape-"));
  secretPath = join(dir, "config.json").replace(/\\/g, "/");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ openai: { apiKey: "TOPSECRET-FILE-1234" } }));
  writeFileSync(join(dir, "secret.key"), "TOPSECRET-KEYFILE-5678");
  process.env.FRIEND_SECRET_KEY = "TOPSECRET-ENV-9999";
  server = createServer((s) => {
    connections++;
    s.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => {
  delete process.env.FRIEND_SECRET_KEY;
  server.close();
});

const run = (language: SandboxLanguage, code: string, timeoutMs = 20_000) => runInSandbox({ language, code, files: {}, timeoutMs });
const everything = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

const readers = (): Record<SandboxLanguage, string> => ({
  node: `
for (const p of ["${secretPath}", "../config.json", "config.json"]) { try { console.log(readFile(p)) } catch (e) { console.log("denied") } }
console.log(typeof process, typeof require, typeof fetch)`,
  python: `
import os
for p in ["${secretPath}", "../config.json", "config.json"]:
    try:
        print(open(p).read())
    except Exception:
        print("denied")
print(dict(os.environ))`,
  shell: `
cat "${secretPath}"; cat ../config.json; cat config.json; ls "${dir.replace(/\\/g, "/")}"; env; echo $FRIEND_SECRET_KEY`,
});

describe("a program cannot find the owner's secrets", () => {
  it.each(["node", "python", "shell"] as SandboxLanguage[])("%s: reading the data folder and the environment finds nothing", async (language) => {
    const r = await run(language, readers()[language]);
    expect(everything(r)).not.toMatch(/TOPSECRET/);
  }, 60_000);

  it("python: even after taking the bridge to Node back, it finds nothing and cannot start a program", async () => {
    const r = await run(
      "python",
      `
import sys
for k in ("js", "pyodide_js", "pyodide.code", "pyodide.ffi"):
    sys.modules.pop(k, None)
out = []
try:
    import js
    out.append(str(js.process.env.to_py()))
    for how in ("process.binding('spawn_sync')", "process.binding('fs')", "process.mainModule", "require('node:fs').readFileSync('${secretPath}','utf8')"):
        try:
            out.append(str(js.eval(how)))
        except Exception as e:
            out.append("denied")
except Exception as e:
    out.append("no bridge")
print("|".join(out))`,
    );
    expect(everything(r)).not.toMatch(/TOPSECRET/);
    expect(everything(r)).not.toMatch(/spawn_sync.*function|\[object Object\]/i);
  }, 60_000);
});

describe("a program cannot reach the network", () => {
  it("node: there is no way to ask", async () => {
    connections = 0;
    const r = await run("node", `console.log(typeof fetch, typeof XMLHttpRequest, typeof WebSocket)`);
    expect(r.stdout).toBe("undefined undefined undefined\n");
    expect(connections).toBe(0);
  });

  it("python: sockets, urllib and the host's fetch all fail, and the local server sees nothing", async () => {
    connections = 0;
    const r = await run(
      "python",
      `
import socket, urllib.request, sys
for how in (
    lambda: socket.create_connection(("127.0.0.1", ${port}), timeout=2),
    lambda: urllib.request.urlopen("http://127.0.0.1:${port}/", timeout=2),
):
    try:
        how()
        print("CONNECTED")
    except BaseException:
        print("failed")
for k in ("js", "pyodide_js"):
    sys.modules.pop(k, None)
try:
    import js
    js.fetch("http://127.0.0.1:${port}/")
    print("FETCHED")
except BaseException:
    print("no fetch")
try:
    js.eval("import('node:net').then(n => n.connect(${port}, '127.0.0.1'))")
except BaseException:
    pass
import time
time.sleep(0.5)`,
    );
    expect(r.stdout).not.toMatch(/CONNECTED|FETCHED/);
    await new Promise((res) => setTimeout(res, 300));
    expect(connections).toBe(0);
  }, 60_000);

  it("shell: curl is not there", async () => {
    connections = 0;
    const r = await run("shell", `curl http://127.0.0.1:${port}/ ; wget http://127.0.0.1:${port}/ ; nc 127.0.0.1 ${port}`);
    expect(r.code).not.toBe(0);
    expect(connections).toBe(0);
  });
});

describe("nothing carries over from one run to the next", () => {
  it("shell: a file written in one run is gone in the next", async () => {
    await run("shell", "echo left > left.txt");
    expect((await run("shell", "ls")).stdout).not.toContain("left.txt");
  });
  it("node: a global set in one run is gone in the next", async () => {
    await run("node", "globalThis.left = 1");
    expect((await run("node", "console.log(typeof left)")).stdout).toBe("undefined\n");
  });
});

describe("a program that misbehaves is stopped, and the next one still runs", () => {
  const bad: [SandboxLanguage, string, string][] = [
    ["node", "endless loop", "while(true){}"],
    ["python", "endless loop", "while True: pass"],
    ["shell", "endless loop", "while true; do :; done"],
    ["node", "endless output", 'while(true){ console.log("x".repeat(1000)) }'],
    ["python", "endless output", 'while True: print("x" * 1000)'],
    ["shell", "endless output", 'while true; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done'],
    ["node", "memory bomb", "const a=[]; while(true){ a.push('x'.repeat(1e6)) }"],
    ["python", "memory bomb", "a=[]\nwhile True: a.append('x' * 10**7)"],
  ];
  it.each(bad)("%s: %s", async (language, _what, code) => {
    const t = Date.now();
    const r = await run(language, code, 3000);
    expect(Date.now() - t).toBeLessThan(25_000);
    expect(r.stdout.length).toBeLessThanOrEqual(40_000);
    expect(r.timedOut || r.code !== 0 || r.outOfMemory).toBe(true);
    const next = await run(language, language === "node" ? "console.log(1)" : language === "python" ? "print(1)" : "echo 1");
    expect(next.stdout).toBe("1\n");
  }, 90_000);
});
