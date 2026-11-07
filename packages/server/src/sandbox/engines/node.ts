import { getQuickJS } from "quickjs-emscripten";
import { MAX_SANDBOX_OUTPUT, type SandboxInput, type SandboxResult } from "../types";

const MEMORY_BYTES = 256 * 1024 * 1024;
const STACK_BYTES = 1024 * 1024;

/**
 * JavaScript in QuickJS (WebAssembly). The program gets console.log / console.error and readFile(name) for the files it was given.
 * It has no require, no process, no fetch and no file system: those simply do not exist in this engine.
 */
export async function runNode(input: SandboxInput): Promise<SandboxResult> {
  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(MEMORY_BYTES);
  rt.setMaxStackSize(STACK_BYTES);
  const deadline = Date.now() + input.timeoutMs;
  let out = "";
  let err = "";
  let tooMuch = false;
  let timedOut = false;
  rt.setInterruptHandler(() => {
    if (tooMuch) return true;
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });
  const vm = rt.newContext();
  try {
    const add = (which: "out" | "err", text: string) => {
      if (which === "out") out += text;
      else err += text;
      if (out.length + err.length > MAX_SANDBOX_OUTPUT) tooMuch = true;
    };
    const show = (args: unknown[]) => args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" ") + "\n";
    const console_ = vm.newObject();
    for (const [name, which] of [["log", "out"], ["info", "out"], ["error", "err"], ["warn", "err"]] as const) {
      const fn = vm.newFunction(name, (...args) => {
        add(which, show(args.map((h) => vm.dump(h))));
      });
      vm.setProp(console_, name, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, "console", console_);
    console_.dispose();
    const readFile = vm.newFunction("readFile", (nameHandle) => {
      const name = String(vm.dump(nameHandle));
      if (!Object.prototype.hasOwnProperty.call(input.files, name)) return { error: vm.newString(`No such file: ${name}`) };
      return vm.newString(input.files[name]!);
    });
    vm.setProp(vm.global, "readFile", readFile);
    readFile.dispose();

    const r = vm.evalCode(input.code, "main.js");
    let code = 0;
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      const o = typeof e === "object" && e ? (e as { name?: string; message?: string; stack?: string }) : null;
      const message = o ? `${o.name ?? "Error"}: ${o.message ?? ""}\n${o.stack ?? ""}` : String(e);
      if (!timedOut && !tooMuch) err += message.endsWith("\n") ? message : message + "\n";
      code = 1;
    } else {
      r.value.dispose();
      // let promises settle (async code), within the same limits
      while (!timedOut && !tooMuch && rt.hasPendingJob()) {
        const jobs = rt.executePendingJobs();
        if (jobs.error) {
          const e = vm.dump(jobs.error);
          jobs.error.dispose();
          err += `${(e as { message?: string } | null)?.message ?? String(e)}\n`;
          code = 1;
          break;
        }
      }
    }
    const outOfMemory = /out of memory/i.test(err);
    if (timedOut) code = 1;
    return { code: timedOut ? null : code, stdout: out.slice(0, MAX_SANDBOX_OUTPUT), stderr: err.slice(0, MAX_SANDBOX_OUTPUT), timedOut, outOfMemory };
  } finally {
    try {
      vm.dispose();
      rt.dispose();
    } catch {
      /* the engine is thrown away with the worker anyway */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "undefined" ? "undefined" : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
