import { createSocket, type Socket } from "node:dgram";
import { userInfo, homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInSandbox, type SandboxLanguage } from "./index";

// Findings of the fresh review of the branch, each pinned by a test that failed first.
let udp: Socket;
let udpPort = 0;
let datagrams: string[] = [];

beforeAll(async () => {
  udp = createSocket("udp4");
  udp.on("message", (m) => datagrams.push(m.toString()));
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
  udpPort = udp.address().port;
});
afterAll(() => udp.close());

const py = (code: string, timeoutMs = 25_000) => runInSandbox({ language: "python", code, files: {}, timeoutMs });
const run = (language: SandboxLanguage, code: string, timeoutMs = 25_000) => runInSandbox({ language, code, files: {}, timeoutMs });
const settle = () => new Promise((r) => setTimeout(r, 400));

describe("C1: no UDP and no DNS, even when Python gets its bridge to Node back", () => {
  it("a datagram sent through Node's dgram never arrives", async () => {
    datagrams = [];
    await py(`
import sys
for k in ("js", "pyodide_js", "pyodide.code", "pyodide.ffi", "_pyodide_core"):
    sys.modules.pop(k, None)
tries = [
    "import js; P = js.process.getBuiltinModule('dgram'); P.createSocket('udp4').send('LEAK-a', ${udpPort}, '127.0.0.1')",
    "import js; P = js.process.getBuiltinModule('dgram'); P.Socket.new('udp4').send('LEAK-b', ${udpPort}, '127.0.0.1')",
    "from pyodide.code import run_js; run_js(\\"process.getBuiltinModule('dgram').Socket.new ? 0 : 0\\")",
    "from pyodide.code import run_js; run_js(\\"const d = process.getBuiltinModule('dgram'); const s = new d.Socket({type:'udp4'}); s.send('LEAK-c', ${udpPort}, '127.0.0.1')\\")",
    "from pyodide.code import run_js; run_js(\\"import('node:dgram').then(d => new d.Socket({type:'udp4'}).send('LEAK-d', ${udpPort}, '127.0.0.1'))\\")",
]
import time
for t in tries:
    try:
        exec(t)
    except BaseException as e:
        print("failed")
time.sleep(0.5)
`);
    await settle();
    expect(datagrams).toEqual([]);
  }, 60_000);

  it("a DNS question through Node's resolver never leaves", async () => {
    datagrams = [];
    await py(`
import sys, time
for k in ("js", "pyodide_js", "pyodide.code", "pyodide.ffi", "_pyodide_core"):
    sys.modules.pop(k, None)
tries = [
    "import js; D = js.process.getBuiltinModule('dns'); r = D.Resolver.new(); r.setServers(['127.0.0.1:${udpPort}']); r.resolve4('stolen.example.com', lambda *a: None)",
    "from pyodide.code import run_js; run_js(\\"const d = process.getBuiltinModule('dns'); const r = new d.Resolver(); r.setServers(['127.0.0.1:${udpPort}']); r.resolve4('stolen2.example.com', () => {})\\")",
    "from pyodide.code import run_js; run_js(\\"import('node:dns').then(d => { const r = new d.Resolver(); r.setServers(['127.0.0.1:${udpPort}']); r.resolve4('stolen3.example.com', () => {}) })\\")",
]
for t in tries:
    try:
        exec(t)
    except BaseException:
        print("failed")
time.sleep(0.5)
`);
    await settle();
    expect(datagrams).toEqual([]);
  }, 60_000);
});

describe("I1: nothing in the environment says who the owner is", () => {
  it.each(["python", "node", "shell"] as SandboxLanguage[])("%s: no user name and no home folder", async (language) => {
    const code = {
      python: "import os\nprint(dict(os.environ))\nimport sys\nfor k in ('js',):\n    sys.modules.pop(k, None)\ntry:\n    import js\n    e = js.process.env\n    for k in ('USERPROFILE', 'USERNAME', 'HOMEPATH', 'TEMP', 'TMP', 'LOGONSERVER', 'USERDOMAIN', 'PATH', 'HOME'):\n        print(k, str(getattr(e, k, '')))\nexcept BaseException:\n    print('no bridge')",
      node: "console.log(typeof process)",
      shell: "env; echo $USERPROFILE $HOME $USERNAME",
    }[language];
    const r = await run(language, code);
    const text = r.stdout + r.stderr;
    for (const secret of [userInfo().username, homedir()]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
  }, 60_000);
});

describe("I2: Python cannot use more than its memory limit", () => {
  it("is stopped with a MemoryError well under 700 MB", async () => {
    const r = await py(
      `
a = []
n = 0
try:
    while True:
        a.append('x' * 10**6)
        n += 1
except MemoryError:
    print("MB", n)
`,
      40_000,
    );
    const mb = Number(/MB (\d+)/.exec(r.stdout)?.[1] ?? Infinity);
    expect(mb).toBeGreaterThan(50);
    expect(mb).toBeLessThan(700);
  }, 90_000);
});
