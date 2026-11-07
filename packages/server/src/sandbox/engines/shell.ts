import { MAX_SANDBOX_OUTPUT, type SandboxInput, type SandboxResult } from "../types";

const HOME = "/home/user";

/**
 * Shell scripts in just-bash: a bash interpreter written in JavaScript that works on an in-memory folder holding only the files the
 * program was given. It is not a real shell: it has a fixed set of built-in commands and runs no other program. No network, no real files.
 */
export async function runShell(input: SandboxInput): Promise<SandboxResult> {
  const { Bash } = await import("just-bash");
  const files: Record<string, string> = {};
  for (const [name, body] of Object.entries(input.files)) files[`${HOME}/${name}`] = body;
  const sh = new Bash({ files, cwd: HOME, env: { HOME, USER: "user", PATH: "/usr/bin:/bin" } });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const r = await sh.exec(input.code, { signal: controller.signal });
    // "bash: curl: command not found" says nothing about why; name the sandbox and the way out
    const stderr = r.stderr.replace(/^(?:bash: )?([^\s:]+): command not found$/gm, (_m, cmd: string) => `This script needs the command ${cmd}, which the built-in sandbox does not have. Install Docker to run it.`);
    return { code: timedOut ? null : r.exitCode, stdout: r.stdout.slice(0, MAX_SANDBOX_OUTPUT), stderr: stderr.slice(0, MAX_SANDBOX_OUTPUT), timedOut, outOfMemory: false };
  } catch (e) {
    return { code: timedOut ? null : 1, stdout: "", stderr: `${e instanceof Error ? e.message : String(e)}\n`, timedOut, outOfMemory: false };
  } finally {
    clearTimeout(timer);
  }
}
