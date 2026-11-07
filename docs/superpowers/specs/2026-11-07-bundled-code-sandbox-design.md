# Bundled code sandbox (no Docker needed) — design

Status: draft for the owner's review. Date: 2026-11-07.

## Goal

Let the assistant run the code it writes (JavaScript, Python, shell) safely on Windows, Mac and Linux **without installing anything else**. Docker stays an optional, stronger backend. After this, the only thing needed to use Friend is Node.js 20 or newer.

## What exists today

`packages/server/src/codebox.ts`: `CodeBox.run({language: "python"|"node"|"shell", code, timeoutSec?, files?})` starts a throwaway Docker container (no network, read-only root, no capabilities, 512 MB, 1 CPU, 128 processes) and returns `{ok, exitCode, stdout, stderr, timedOut}` or `{ok:false, error}`. Without Docker it answers "Docker is not available". Callers: `agent/loop.ts`, `app.ts`. Limits: 50,000 characters of code, 20,000 of output, 10 files, timeout 10 s (max 60 s).

## Decisions made with the owner

- Languages in the bundled sandbox: **JavaScript, Python and shell**.
- The Python runtime is **shipped inside the npm package** (works offline from the first minute; larger install).
- Docker remains an optional backend; the choice is a setting (configurable, safety limits fixed).

## Design

### Routing

`CodeBox.run()` keeps its input and output types unchanged, so the agent tool and its tests do not change. It chooses a backend per call from a new setting `codeRunner`:

| Value | Behaviour |
|---|---|
| `auto` (default) | Docker if it is installed and running, otherwise the bundled sandbox. Shell scripts prefer Docker when present (a real shell), otherwise the emulation. |
| `sandbox` | Always the bundled sandbox. |
| `docker` | Always Docker (today's behaviour, including its error messages). |

`friend config set codeRunner sandbox` and a Settings entry change it. The result says which backend ran (`runner: "sandbox" | "docker"`) so the assistant can tell the owner.

### The bundled sandbox

Each run starts a **fresh `worker_threads` worker** that is destroyed afterwards, so no state carries from one run to the next. The worker is given `resourceLimits` (memory cap, 512 MB total, stack) and the parent kills it (`worker.terminate()`) at the timeout.

| Language | Engine | Notes |
|---|---|---|
| JavaScript | `quickjs-emscripten` (MIT, WebAssembly, about 2.4 MB) | A bare JavaScript engine: no `require`, no `fs`, no `fetch`, no `process`. Only `console.log` and the in-memory files are provided. |
| Python | `pyodide` (MPL-2.0, WebAssembly, about 14 MB) | Standard library only (no numpy/pandas in the first version). No network: `urllib`/`socket` cannot connect, the runtime has no host network access. |
| Shell | `just-bash` (Apache-2.0, in-memory bash interpreter in TypeScript, about 22 MB unpacked) | Not a real shell: a documented set of built-in commands over an in-memory folder. A script that needs `curl`, `git`, a compiler or any program outside that set fails with a clear message naming the command. |

Candidate libraries are **to be verified in the plan's first task** (works inside a worker on all three systems, versions pinned, licences compatible, size measured in the packed npm tarball). If one fails verification, that language falls back to Docker-only with a clear message, and the spec is updated.

### Files and isolation

- The only files visible to the code are an **in-memory folder** holding the program and the `files` the caller passes (same name rules and limits as today).
- Nothing on the owner's disk is reachable: no real `fs`, no `config.json`, no data folder.
- No network: the engines have no network API, and the worker is started without `fetch`/`http` being exposed to guest code.
- Output is capped at 20,000 characters (`[output cut]`), memory growth in the worker is capped, and a program that prints without end is stopped (bounded buffer, as in `spawnDocker`).
- Safety limits are **fixed** (memory, output, code size, maximum timeout). Only the runner choice and the default timeout are settings.

### Honest limits (shown to the assistant in the tool description)

- Shell: emulated, a subset of commands.
- Python: standard library only; a script importing `numpy` gets "not available in the built-in sandbox; install Docker to use it".
- Slower than native; startup about 1 s for Python the first time in a process (the runtime is loaded once per worker).
- CPU time is bounded by the timeout; memory by the worker limit.

### Wizard, docs, doctor

- `friend onboard` and `friend doctor`: Docker is no longer listed as needed for running code; it is described as "optional: a real container for scripts the built-in sandbox cannot run".
- README: requirements say only "Node.js 20 or newer"; the code-running section is rewritten; the new setting is documented; the sandbox's limits are listed.
- Package size: about 38 MB unpacked is added (to be measured; the compressed tarball is smaller). The plan records the measured number and the owner is told before release.

### Security and audit

- Every run goes through the same approval and audit path as today (`code.run`); the audit detail records language and backend, not the code output beyond what is logged now.
- The sandbox is a trust boundary for code written by an AI that may be steered by untrusted text, so it ships with **escape tests**: guest code cannot read `config.json` or any real file, cannot reach the network, cannot see environment variables or the owner's secrets, cannot exceed the time or memory limit (the process survives and reports `timedOut` or an out-of-memory error), and cannot affect a later run.
- A guest crash or infinite loop never takes down Friend (the worker is isolated and terminated).

### Error messages

Plain words, no jargon: for example "This script needs the command `curl`, which the built-in sandbox does not have. Install Docker to run it." and "Python ran out of memory (limit 512 MB)."

## Testing

- Unit: routing (`auto`/`sandbox`/`docker`, Docker present or missing), input validation unchanged, output and file limits.
- Per language: hello world, stdin-less arithmetic, files passed in, a runtime error gives a non-zero exit code and stderr, a timeout kills it, output cap, memory cap.
- Escape tests listed above, run for each language.
- The existing Docker tests stay (they skip when Docker is absent).
- Cross-platform: the plan includes a check on Windows, and a CI/matrix note for Mac and Linux (the owner's machine is Windows; Mac and Linux are verified by the library's own support plus a smoke test, and the plan says so).

## Out of scope

- Extra Python packages (numpy, pandas) and other languages.
- A real shell or running native programs without Docker.
- Network access for guest code.
- Persisting files between runs.

## Open questions for the plan

1. Do `quickjs-emscripten`, `pyodide` and `just-bash` run correctly inside a `worker_threads` worker on Windows (Node 20 and 22)? Pin versions.
2. Can Pyodide's network be fully disabled, or must the worker block it (for example by not providing `fetch` in the worker)?
3. Measured packed size, and whether `just-bash` can be trimmed (it may bundle features Friend does not use).
4. Should the first Python start be warmed in the background when Friend starts? (Default: no, start on first use.)

## Findings from the feasibility check (Task 1, 2026-11-07)

- All three engines run inside a `worker_threads` worker on Windows (Node 22): `quickjs-emscripten@0.32.0`, `pyodide@314.0.7`, `just-bash@3.6.0` (versions pinned exactly). Mac and Linux are not checked on this PC; the libraries are pure JavaScript/WebAssembly with no required native parts (`just-bash` lists `@mongodb-js/zstd` and `node-liblzma` only as optional dependencies).
- Unpacked sizes: quickjs-emscripten 2.4 MB, pyodide 14 MB, just-bash 21 MB (it depends on `typescript`, `sql.js` and others, more than Friend needs; trimming is not possible without forking, so it is accepted for now and the packed size is measured in Task 8).
- Packaging decision: the three libraries become **dependencies of the npm package** (`packages/friend/package.json`, pinned), like the other packages from npm, so their `.wasm` files come from `node_modules` and need no copying. The worker is **our** file: `scripts/bundle.mjs` builds it to `dist/sandbox-worker.mjs` (libraries external). In the source tree and in tests the worker is compiled once with esbuild into `packages/server/.sandbox-dev/worker.mjs` (git-ignored) so it resolves the same `node_modules`.

## Design change found while building (Task 3/4, 2026-11-07)

A probe showed that Python in Pyodide is **not** isolated by being WebAssembly: through its `js` bridge it reached Node and started a program (`SPAWN OK`) and could read files. So the sandbox does not run in a `worker_threads` worker as first written. It runs in a **separate Node process** started with Node's permission model (`--permission`, or `--experimental-permission` on Node 20), which denies reading files outside the sandbox program and the engine folders, starting programs, threads and `process.binding`; with an **empty environment**, a memory cap (`--max-old-space-size=512`), the network modules switched off inside it, and a kill at the time limit. The same probe, run under the permission model, could no longer read `config.json` or start a program. Network blocking is done by disabling Node's network modules and `fetch` in the process (not by the operating system), and the escape tests exercise it against a real local server. The program that runs in the process is built from `src/sandbox/child.ts` (`.sandbox-dev/child.mjs` for the source tree and tests; `dist/sandbox-child.mjs` in the package). Cost: about 0.2 to 1 s to start a run.
