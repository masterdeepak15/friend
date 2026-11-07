import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import { MAX_SANDBOX_OUTPUT, SANDBOX_MEMORY_MB, type SandboxInput, type SandboxResult } from "../types";

// Python runs the program with this wrapper: the exit code of sys.exit is kept and an error prints its traceback.
const HARNESS = `
import sys, traceback

def __friend_run(src):
    g = {"__name__": "__main__", "__file__": "main.py"}
    try:
        exec(compile(src, "main.py", "exec"), g)
        return 0
    except SystemExit as e:
        c = e.code
        if c is None:
            return 0
        if isinstance(c, int):
            return c
        print(c, file=sys.stderr)
        return 1
    except BaseException:
        traceback.print_exc()
        return 1
`;

// Takes the bridge to the host (the js module and pyodide's own helpers) out of the program's reach. The sandbox process is already
// locked down by Node itself; this is a second layer.
const CLOSE_BRIDGE = `
import sys
for name in ("js", "pyodide_js", "pyodide.code", "pyodide.ffi", "_pyodide_core", "pyodide.webloop", "pyodide.http", "micropip"):
    sys.modules[name] = None
`;

/**
 * Python in Pyodide (WebAssembly): the standard library only. The program sees only an in-memory folder holding main.py and the
 * files it was given. Its network does not exist (no sockets in the engine, and the sandbox process has its network modules off).
 */
export async function runPython(input: SandboxInput): Promise<SandboxResult> {
  // WebAssembly memory is outside Node's heap limit, so cap it here: when Python's allocator asks for more than the limit the request
  // is refused and Python raises a MemoryError, instead of taking gigabytes.
  const limitPages = (SANDBOX_MEMORY_MB * 1024 * 1024) / 65536;
  const realGrow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function (this: WebAssembly.Memory, delta: number): number {
    if (this.buffer.byteLength / 65536 + delta > limitPages) throw new RangeError("The program asked for more memory than the sandbox allows.");
    return realGrow.call(this, delta);
  };
  // Pyodide's start-up asks Node for its constants through process.binding, which the permission model refuses; give it just those.
  (process as unknown as { binding: (name: string) => unknown }).binding = (name: string) => {
    if (name === "constants") return { fs: fsConstants, os: osConstants, crypto: {}, zlib: {}, trace: {} };
    throw new Error(`process.binding is not available: ${name}`);
  };
  const { loadPyodide } = await import("pyodide");
  let out = "";
  let err = "";
  const add = (which: "out" | "err", line: string) => {
    if (out.length + err.length >= MAX_SANDBOX_OUTPUT) return;
    if (which === "out") out += line + "\n";
    else err += line + "\n";
  };
  const py = await loadPyodide({ stdout: (s: string) => add("out", s), stderr: (s: string) => add("err", s) });
  py.runPython(HARNESS);
  for (const [name, body] of Object.entries(input.files)) py.FS.writeFile(`/home/pyodide/${name}`, body);
  py.FS.writeFile("/home/pyodide/main.py", input.code);
  py.globals.set("__friend_src", input.code);
  py.runPython(CLOSE_BRIDGE);
  // no handle to Node's own modules from here on (the network modules are already switched off in lockdown.ts)
  delete (process as unknown as { getBuiltinModule?: unknown }).getBuiltinModule;
  let code: number | null = 1;
  try {
    code = Number(await py.runPythonAsync("__friend_run(__friend_src)"));
  } catch (e) {
    err += `${e instanceof Error ? e.message : String(e)}\n`;
  }
  const outOfMemory = /MemoryError/.test(err);
  return { code, stdout: out.slice(0, MAX_SANDBOX_OUTPUT), stderr: err.slice(0, MAX_SANDBOX_OUTPUT), timedOut: false, outOfMemory };
}
