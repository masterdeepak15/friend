import { readFileSync } from "node:fs";
import { lockDownNetwork } from "./lockdown";
import type { SandboxInput, SandboxResult } from "./types";

export const RESULT_MARK = "\n@@friend-sandbox-result@@";

// The sandbox process: reads one program from its input, runs it, writes one result. The parent ends it at the time limit.
async function run(input: SandboxInput): Promise<SandboxResult | { unavailable: string }> {
  switch (input.language) {
    case "node":
      return (await import("./engines/node")).runNode(input);
    case "python":
      return (await import("./engines/python")).runPython(input);
    case "shell":
      return (await import("./engines/shell")).runShell(input);
    default:
      return { unavailable: `The built-in sandbox cannot run ${input.language} yet.` };
  }
}

async function main(): Promise<void> {
  const input = JSON.parse(readFileSync(0, "utf8")) as SandboxInput;
  lockDownNetwork();
  let result: SandboxResult | { unavailable: string };
  try {
    result = await run(input);
  } catch (e) {
    result = { unavailable: `The built-in sandbox could not start: ${e instanceof Error ? e.message : String(e)}` };
  }
  process.stdout.write(RESULT_MARK + JSON.stringify(result) + "\n", () => process.exit(0));
}

void main();
