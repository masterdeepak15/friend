import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { MAX_SANDBOX_OUTPUT, SANDBOX_MEMORY_MB, SandboxUnavailable, type SandboxInput, type SandboxResult } from "./types";

export { SandboxUnavailable, type SandboxInput, type SandboxLanguage, type SandboxResult } from "./types";

/** Where the worker program is: next to the packaged program, or, from the source tree, the TypeScript file itself. */
function workerSource(): { file: URL; execArgv: string[] } {
  const bundled = new URL("./sandbox-worker.mjs", import.meta.url);
  if (existsSync(fileURLToPath(bundled))) return { file: bundled, execArgv: [] };
  return { file: new URL("./worker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

/**
 * Runs one program in a fresh worker thread: nothing carries over from an earlier run, the memory is capped, and the thread is
 * ended at the time limit. A program that fails, loops or runs out of memory gives a result, never an error in Friend.
 */
export function runInSandbox(input: SandboxInput): Promise<SandboxResult> {
  const src = workerSource();
  return new Promise<SandboxResult>((resolve, reject) => {
    let done = false;
    const worker = new Worker(src.file, {
      workerData: input,
      execArgv: src.execArgv,
      env: {}, // the program's world has none of Friend's environment variables
      resourceLimits: { maxOldGenerationSizeMb: SANDBOX_MEMORY_MB, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    });
    const finish = (r: SandboxResult | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    // a backstop: the engine stops itself at the limit; this ends the thread if it cannot (for example while still loading)
    const timer = setTimeout(() => finish({ code: null, stdout: "", stderr: "", timedOut: true, outOfMemory: false }), input.timeoutMs + 3000);
    worker.once("message", (m: SandboxResult | { unavailable: string }) => {
      if ("unavailable" in m) finish(new SandboxUnavailable(m.unavailable));
      else finish({ ...m, stdout: m.stdout.slice(0, MAX_SANDBOX_OUTPUT), stderr: m.stderr.slice(0, MAX_SANDBOX_OUTPUT) });
    });
    worker.once("error", (e: Error & { code?: string }) => {
      if (e.code === "ERR_WORKER_OUT_OF_MEMORY") finish({ code: null, stdout: "", stderr: "", timedOut: false, outOfMemory: true });
      else finish(new SandboxUnavailable(`The built-in sandbox could not start: ${e.message}`));
    });
    worker.once("exit", () => finish({ code: null, stdout: "", stderr: "The program ended unexpectedly.\n", timedOut: false, outOfMemory: false }));
  });
}
