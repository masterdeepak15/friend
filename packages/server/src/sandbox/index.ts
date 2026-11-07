import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SANDBOX_OUTPUT, SANDBOX_MEMORY_MB, SandboxUnavailable, type SandboxInput, type SandboxResult } from "./types";

export { SandboxUnavailable, type SandboxInput, type SandboxLanguage, type SandboxResult } from "./types";

const RESULT_MARK = "\n@@friend-sandbox-result@@";

/** The program that runs inside the sandbox process: next to the packaged program, or the one built from the source tree. */
function childFile(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of [join(here, "sandbox-child.mjs"), join(here, "..", "..", ".sandbox-dev", "child.mjs")]) if (existsSync(f)) return f;
  throw new SandboxUnavailable("The built-in sandbox program is missing. Run `pnpm build` (from the source) or reinstall Friend.");
}

/**
 * The node_modules folders that hold the engines: the only places outside the sandbox program that it may read. Both the folder it is
 * reached through (it may be a link, as with pnpm) and the outermost folder the real files sit in.
 */
function engineFolders(child: string): string[] {
  const found = new Set<string>();
  for (let dir = dirname(child); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", "quickjs-emscripten"))) found.add(join(dir, "node_modules"));
    if (dirname(dir) === dir) break;
  }
  try {
    const real = realpathSync(createRequire(import.meta.url).resolve("quickjs-emscripten/package.json"));
    const at = real.indexOf(`${sep}node_modules${sep}`);
    found.add(at >= 0 ? real.slice(0, at + `${sep}node_modules`.length) : dirname(real));
  } catch {
    /* the folders found above are used */
  }
  return [...found];
}

/**
 * What the program sees as its environment. Empty on Mac and Linux. Windows puts the user's own variables (name, home folder, PATH, temp
 * folder) back into an empty environment, so every one of them is given a neutral value instead.
 */
function neutralEnvironment(): Record<string, string> {
  if (process.platform !== "win32") return {};
  const root = process.env.SystemRoot ?? "C:\Windows";
  return {
    SystemRoot: root,
    WINDIR: root,
    PATH: `${root}\system32`,
    SYSTEMDRIVE: "C:",
    USERPROFILE: "C:\sandbox",
    HOMEDRIVE: "C:",
    HOMEPATH: "\sandbox",
    USERNAME: "sandbox",
    USERDOMAIN: "SANDBOX",
    LOGONSERVER: "\\SANDBOX",
    COMPUTERNAME: "SANDBOX",
    TEMP: "C:\sandbox\tmp",
    TMP: "C:\sandbox\tmp",
    APPDATA: "C:\sandbox\appdata",
    LOCALAPPDATA: "C:\sandbox\appdata",
  };
}

function permissionFlag(): string {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has("--permission")) return "--permission";
  if (flags.has("--experimental-permission")) return "--experimental-permission";
  throw new SandboxUnavailable("The built-in sandbox needs Node.js 20 or newer with its permission feature. Update Node.js, or use Docker.");
}

/**
 * Runs one program in a fresh Node process that is locked down (Node's permission model: no file reads outside the engine folders,
 * no programs, no threads; an empty environment; the network modules switched off). Nothing carries over from an earlier run, the
 * memory is capped, and the process is ended at the time limit. A program that fails, loops or runs out of memory gives a result.
 */
export async function runInSandbox(input: SandboxInput): Promise<SandboxResult> {
  const child = childFile();
  const args = [
    permissionFlag(),
    `--allow-fs-read=${dirname(child)}`,
    ...engineFolders(child).map((f) => `--allow-fs-read=${f}`),
    `--max-old-space-size=${SANDBOX_MEMORY_MB}`,
    "--no-warnings",
    child,
  ];
  return new Promise<SandboxResult>((resolve, reject) => {
    let done = false;
    let out = "";
    let err = "";
    let timedOut = false;
    const p = spawn(process.execPath, args, { env: neutralEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const finish = (r: SandboxResult | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      p.kill("SIGKILL");
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    // the engine stops itself at the limit; this ends the process if it cannot (for example while still starting)
    const timer = setTimeout(() => {
      timedOut = true;
      finish({ code: null, stdout: "", stderr: "", timedOut: true, outOfMemory: false });
    }, input.timeoutMs + 3000);
    const cap = MAX_SANDBOX_OUTPUT * 4;
    p.stdout.on("data", (d) => void (out.length < cap && (out += d)));
    p.stderr.on("data", (d) => void (err.length < cap && (err += d)));
    p.on("error", (e) => finish(new SandboxUnavailable(`The built-in sandbox could not start: ${e.message}`)));
    p.on("close", () => {
      if (timedOut) return;
      const at = out.lastIndexOf(RESULT_MARK);
      if (at < 0) {
        // no result: the process died. Running out of memory is the usual reason.
        const oom = /heap out of memory|allocation failed|Reached heap limit/i.test(err);
        finish({ code: null, stdout: "", stderr: oom ? "" : "The program ended unexpectedly.\n", timedOut: false, outOfMemory: oom });
        return;
      }
      try {
        const m = JSON.parse(out.slice(at + RESULT_MARK.length)) as SandboxResult | { unavailable: string };
        if ("unavailable" in m) finish(new SandboxUnavailable(m.unavailable));
        else finish({ ...m, stdout: String(m.stdout).slice(0, MAX_SANDBOX_OUTPUT), stderr: String(m.stderr).slice(0, MAX_SANDBOX_OUTPUT) });
      } catch {
        finish({ code: null, stdout: "", stderr: "The program ended unexpectedly.\n", timedOut: false, outOfMemory: false });
      }
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(input));
  });
}
