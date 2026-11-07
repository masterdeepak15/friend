import { parentPort, workerData } from "node:worker_threads";
import type { SandboxInput, SandboxResult } from "./types";

// Runs in its own thread, once, for one program. The parent ends it at the time limit.
async function run(input: SandboxInput): Promise<SandboxResult | { unavailable: string }> {
  switch (input.language) {
    case "node":
      return (await import("./engines/node")).runNode(input);
    default:
      return { unavailable: `The built-in sandbox cannot run ${input.language} yet.` };
  }
}

run(workerData as SandboxInput).then(
  (r) => parentPort!.postMessage(r),
  (e) => parentPort!.postMessage({ unavailable: `The built-in sandbox could not start: ${e instanceof Error ? e.message : String(e)}` }),
);
