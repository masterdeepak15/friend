# Bundled Code Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant can run JavaScript, Python and shell code on Windows, Mac and Linux with nothing to install; Docker becomes an optional stronger backend.

**Architecture:** `CodeBox.run()` keeps its input/output and chooses a backend per call from a new `codeRunner` setting (`auto` | `sandbox` | `docker`). The bundled sandbox runs each call in a fresh `worker_threads` worker with a memory cap, killed at the timeout, using three WebAssembly/JS engines over an in-memory folder with no network.

**Tech Stack:** TypeScript ESM, Node 20+, `worker_threads`, `quickjs-emscripten` (MIT), `pyodide` (MPL-2.0), `just-bash` (Apache-2.0), vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-bundled-code-sandbox-design.md`

## Global Constraints

- Works on Windows, Mac and Linux; Node.js 20 or newer is the only requirement. No OS-specific code.
- `CodeBox.run(input)` input type is unchanged: `{ language: "python"|"node"|"shell"; code: string; timeoutSec?: number; files?: Record<string,string> }`. Existing limits stay: code 50,000 chars, output 20,000 chars (`[output cut]`), 10 files, 200,000 file chars, file names `^[A-Za-z0-9_.-]{1,64}$`, default timeout 10 s, maximum 60 s.
- Safety limits are **fixed** (worker memory 512 MB, output cap, code size, max timeout). Only `codeRunner` is a setting.
- Guest code never sees the real filesystem, environment variables, network, or Friend's secrets.
- Plain-words error messages, no jargon. Docker's existing messages stay when `codeRunner` is `docker`.
- Nothing is released, pushed to npm, or merged without the owner saying so.
- Library versions are pinned exactly (no `^`).

## Review Focus

- A guest program that loops forever, allocates without end, or prints without end must not hang or crash Friend; the next run still works (Tasks 3–6).
- Guest code must not read `config.json`, `secret.key`, the data folder, or environment variables, and must not reach the network (Task 6).
- A run must not see files or state from an earlier run (Task 6).
- With Docker missing or stopped and `codeRunner: auto`, a run must still succeed in the sandbox, not return a Docker error (Task 7).
- The packed npm tarball must contain the worker and all `.wasm`/runtime files and run from an installed copy, not only from the source tree (Task 8).

---

### Task 1: Feasibility check and packaging decision

**Files:**
- Modify: `packages/server/package.json` (add pinned dependencies)
- Create: `packages/server/src/sandbox/feasibility.test.ts` (kept as a smoke test)
- Modify: `docs/superpowers/specs/2026-11-07-bundled-code-sandbox-design.md` (record findings under "Open questions")

**Interfaces:**
- Produces: the decision of how `worker` and engine assets are located after bundling (recorded in the spec), and exact pinned versions.

- [ ] **Step 1: Install pinned versions** with `pnpm --filter @friend/server add --save-exact quickjs-emscripten pyodide just-bash` (use the versions npm reports; record them).
- [ ] **Step 2: Write the smoke test** that, for each engine, loads it inside a `new Worker(...)` and runs hello world: QuickJS `console.log(1+1)` prints `2`; Pyodide `print(1+1)` prints `2`; just-bash `echo hi` prints `hi`. Assert stdout and exit code 0. Name the tests `"quickjs runs in a worker"`, `"pyodide runs in a worker"`, `"just-bash runs in a worker"`.
- [ ] **Step 3: Run** `npx vitest run src/sandbox/feasibility.test.ts` in `packages/server`. Expected: all three pass on this PC. A failing engine means that language falls back to Docker-only: record it in the spec, tell the owner, and drop that language's later tasks.
- [ ] **Step 4: Measure** unpacked size of each dependency (`du` of `node_modules/<pkg>`) and note what `just-bash` bundles that Friend does not need; record numbers in the spec.
- [ ] **Step 5: Decide packaging.** Read `packages/friend/scripts/bundle.mjs` and the server's build to see how the server ships. Decide and record: where the worker file is emitted, and how `.wasm`/Pyodide files are copied into `packages/friend/dist` so they resolve at runtime (for example via `import.meta.url`). Commit: `git commit -m "chore: pin sandbox engines and record feasibility"`.

### Task 2: The `codeRunner` setting

**Files:**
- Modify: `packages/server/src/config.ts` (type, sanitizer, default, `loadConfig`)
- Modify: `packages/server/src/settings.ts` and the settings route to accept/return it; `packages/web/src/settings/SettingsPanel.tsx`, `settingsApi.ts`; `packages/agent-cli/src/commands/config.ts` so `friend config set codeRunner sandbox` works
- Test: `packages/server/src/config.coderunner.test.ts`, existing settings/CLI tests

**Interfaces:**
- Produces: `export type CodeRunnerMode = "auto" | "sandbox" | "docker"`; `export const sanitizeCodeRunner = (v: unknown): CodeRunnerMode` (anything else → `"auto"`); `Config.codeRunner: CodeRunnerMode`.

- [ ] **Step 1: Write failing tests:** `sanitizeCodeRunner("sandbox")` is `"sandbox"`; `"docker"` and `"auto"` pass; `"banana"`, `42`, `undefined` give `"auto"`; `loadConfig` of a file with `codeRunner: "docker"` returns it and of an empty file returns `"auto"`; a settings round trip (GET then PUT `{codeRunner:"sandbox"}`) persists it; `friend config set codeRunner sandbox` stores it and `friend config set codeRunner nope` is refused with a message naming the three values.
- [ ] **Step 2: Run** them; Expected: FAIL (missing export / unknown key).
- [ ] **Step 3: Implement** the type, sanitizer and wiring following the pattern of `sanitizeSession`/`sanitizeUpdates`; add a Settings dropdown "Run code: automatically / built-in sandbox / Docker" with one line of help each.
- [ ] **Step 4: Run** the new tests plus `npx vitest run` in `packages/server`, `packages/agent-cli`, `packages/web`. Expected: PASS, and `docs.test.ts` (README lists every setting/env var) updated if it requires `codeRunner` to be documented. Commit.

### Task 3: Sandbox core and the JavaScript engine

**Files:**
- Create: `packages/server/src/sandbox/types.ts`, `index.ts`, `worker.ts`, `engines/node.ts`
- Test: `packages/server/src/sandbox/node.test.ts`

**Interfaces:**
- Produces (`types.ts`): `SandboxInput = { language: "python"|"node"|"shell"; code: string; files: Record<string,string>; timeoutMs: number }`; `SandboxResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; outOfMemory: boolean }`; `class SandboxUnavailable extends Error`.
- Produces (`index.ts`): `runInSandbox(input: SandboxInput): Promise<SandboxResult>` — starts a fresh `Worker` with `resourceLimits: { maxOldGenerationSizeMb: 512 }`, sends the input, collects the result, `terminate()`s the worker on timeout (`timedOut: true`) or when output passes 40,000 chars, and maps a worker out-of-memory exit to `outOfMemory: true`. Never rejects for guest failures.
- Consumes: Task 1's packaging decision for locating `worker`.

- [ ] **Step 1: Write failing tests** (`node.test.ts`): `console.log(2+3)` → stdout `"5\n"`, code 0; `throw new Error("boom")` → code non-zero and stderr contains `boom`; a file passed in `files` is readable through the provided `readFile("data.txt")` helper and `require`, `process`, `fetch`, `fs` are `undefined`/missing (a program printing `typeof process` prints `undefined`); `while(true){}` with `timeoutMs: 500` → `timedOut: true` returned in under 2 s; a program printing in an endless loop returns with stdout ≤ 40,000 chars; `new Array(1e9).fill(1)` returns `outOfMemory: true` or non-zero code, and a **following** `console.log(1)` run still prints `1\n` (Friend and the next run unaffected).
- [ ] **Step 2: Run** `npx vitest run src/sandbox/node.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `types.ts`, `index.ts` and `worker.ts` (message in/out, engine dispatch by language) and `engines/node.ts` using `quickjs-emscripten` with its interrupt handler tied to a deadline, memory limit set on the runtime, `console.log/error` captured, and `readFile(name)` serving only the in-memory `files`.
- [ ] **Step 4: Run** the tests. Expected: PASS. Commit: `feat(sandbox): worker core and JavaScript engine`.

### Task 4: Python engine

**Files:**
- Create: `packages/server/src/sandbox/engines/python.ts`
- Modify: `packages/server/src/sandbox/worker.ts` (dispatch)
- Test: `packages/server/src/sandbox/python.test.ts`

**Interfaces:**
- Consumes: `SandboxInput`/`SandboxResult`, `runInSandbox` (Task 3).

- [ ] **Step 1: Write failing tests:** `print(sum(range(5)))` → `"10\n"`; `1/0` → code non-zero, stderr contains `ZeroDivisionError`; `files: {"args.json": '{"value":5}'}` is readable with `open("args.json")` and `json.load`; `import numpy` → code non-zero and stderr (as returned to the caller) contains `numpy`; `import socket; socket.create_connection(("1.1.1.1",80),timeout=2)` fails (non-zero) and never connects; `import os; print(os.listdir("/"))` shows no host directories (no `Users`, `home`, `etc/passwd` of the host: assert the output does not contain the real data folder name); `while True: pass` with `timeoutMs: 1000` → `timedOut`; two runs in a row do not share variables or files.
- [ ] **Step 2: Run** `npx vitest run src/sandbox/python.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the engine: load Pyodide from the packaged location, mount only an in-memory folder with `files` and `main.py`, redirect stdout/stderr, run with `-I`-like isolation (no site customizations), disable `fetch`/network access for the runtime (open question 2: block in the worker if Pyodide cannot), map uncaught Python errors to exit code 1 with the traceback on stderr.
- [ ] **Step 4: Run** the tests. Expected: PASS. Commit: `feat(sandbox): Python engine`.

### Task 5: Shell engine

**Files:**
- Create: `packages/server/src/sandbox/engines/shell.ts`
- Modify: `packages/server/src/sandbox/worker.ts`
- Test: `packages/server/src/sandbox/shell.test.ts`

- [ ] **Step 1: Write failing tests:** `echo hi | tr a-z A-Z` → `"HI\n"`; `ls` lists passed-in files; `cat data.txt | wc -l` counts lines of a passed-in file; `exit 3` → code 3; `curl http://example.com` → non-zero and stderr names the command `curl` with the words "built-in sandbox"; `cat /etc/passwd` and `cat ../../config.json` find nothing real (non-zero exit); an endless `while true; do :; done` with `timeoutMs: 500` → `timedOut`.
- [ ] **Step 2: Run** `npx vitest run src/sandbox/shell.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `just-bash` over an in-memory filesystem seeded only with the program and `files`; no real fs, no network, no host environment variables; unknown command → the plain-words message above.
- [ ] **Step 4: Run** the tests. Expected: PASS. Commit: `feat(sandbox): shell engine`.

### Task 6: Escape and limits suite

**Files:**
- Create: `packages/server/src/sandbox/escape.test.ts`

**Interfaces:**
- Consumes: `runInSandbox` and the three engines (Tasks 3–5).

- [ ] **Step 1: Write the suite, run for each language (`it.each`)**, with a real temp data folder containing `config.json` (`{"secret":"TOPSECRET-1234"}`) and `secret.key`, and `process.env.FRIEND_SECRET_KEY = "TOPSECRET-ENV"` set: for every language, a program trying to find those contents (reading by absolute path, relative `../`, listing `/`, printing environment) never outputs `TOPSECRET`; a program trying a network connection never succeeds; a program that writes a file in one run does not find it in the next run; an infinite loop, endless output and a memory bomb each finish within `timeoutMs + 2000` ms and leave a following hello-world run working.
- [ ] **Step 2: Run** `npx vitest run src/sandbox/escape.test.ts`. Expected: PASS for every row (this suite pins behaviour Tasks 3–5 built; any FAIL is a real hole: fix the engine, not the test).
- [ ] **Step 3: Commit** `test(sandbox): escape and limits suite`.

### Task 7: Routing in `CodeBox`

**Files:**
- Modify: `packages/server/src/codebox.ts`, `packages/server/src/app.ts` (construct `new CodeBox(spawnDocker, { mode: () => config.codeRunner })`), the agent code tool's description in `packages/server/src/agent/` (the file that registers the "run code" tool; find it with the tests `agent/code.test.ts`)
- Test: `packages/server/src/codebox.routing.test.ts`; existing `codebox*.test.ts`, `agent/code.test.ts`, `agent/plugins.test.ts`

**Interfaces:**
- Produces: `class CodeBox { constructor(docker: DockerExec = spawnDocker, opts: { mode?: () => CodeRunnerMode; sandbox?: (i: SandboxInput) => Promise<SandboxResult> } = {}) }` where `mode` defaults to `() => "docker"` (so existing tests are unchanged), `sandbox` defaults to `runInSandbox`. `RunResult`'s ok variant gains `runner: "sandbox" | "docker"`.
- Rules: `docker` → today's behaviour. `sandbox` → sandbox only. `auto` → try Docker; if Docker is missing (ENOENT), not running, or cannot start the container, run in the sandbox instead; availability is cached for 60 s (injectable clock). Input validation runs before any backend. A sandbox result maps to `RunResult` (`exitCode`, `stdout`/`stderr` clipped by `clip`, `timedOut`); `outOfMemory` becomes stderr text "The program ran out of memory (limit 512 MB)."; `SandboxUnavailable` becomes `{ ok:false, error }` naming the language and suggesting Docker.

- [ ] **Step 1: Write failing tests** with a fake docker and fake sandbox: mode `docker` with missing Docker still returns the old error text; mode `sandbox` never calls docker; mode `auto` with docker ENOENT calls the sandbox and returns `ok:true, runner:"sandbox"`; auto with docker working returns `runner:"docker"` and never calls the sandbox; auto with the daemon stopped (code 125, stderr "Cannot connect to the Docker daemon") falls back; after a fallback the next call within 60 s does not spawn docker again, and after 61 s it does; invalid input (empty code, 50,001 chars, bad file name) is refused identically in all modes without touching a backend; out-of-memory result gives the plain message; a timeout gives `timedOut: true`.
- [ ] **Step 2: Run** `npx vitest run src/codebox.routing.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routing as specified; update `app.ts`; update the code tool description to state the built-in sandbox's limits (shell is emulated, Python is standard library only, no network, no files between runs) and that `runner` tells which backend ran. Update any existing test that uses `toEqual` on a successful run result to expect `runner: "docker"`.
- [ ] **Step 4: Run** `npx vitest run` in `packages/server`. Expected: PASS (Docker-dependent `codebox.real.test.ts` still skips without Docker). Commit: `feat(sandbox): choose Docker or the built-in sandbox per run`.

### Task 8: Setup, docs and packaging

**Files:**
- Modify: `packages/agent-cli/src/commands/onboard/prereq.ts` and the step that lists choices (Docker becomes optional: "a real container for scripts the built-in sandbox cannot run"); `friend doctor` text; `README.md` (requirements: only Node.js 20+, rewrite the code-running paragraph at the "Docker Desktop" section, document `codeRunner` and the sandbox limits); `docs/guides/` if a guide mentions Docker; `packages/friend/scripts/bundle.mjs` per Task 1's decision
- Test: `packages/agent-cli` onboard/doctor tests, `packages/friend` package test (extend to run a code call from the packed output)

- [ ] **Step 1: Write failing tests:** the onboarding "what this PC needs" list does not mark Docker as required when only "safe code running" is chosen and says it is optional; doctor prints Docker as optional; the package test unpacks the built `dist`, starts `runInSandbox`-equivalent through the packaged entry for each language (`print(1)`, `console.log(1)`, `echo 1`) and gets `1`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the wording, bundling (worker + wasm + Pyodide files present in `dist`), README and guide changes. Record the measured packed tarball size (`npm pack --dry-run` in `packages/friend`) in the spec and tell the owner.
- [ ] **Step 4: Run** `pnpm package`, then the `packages/friend` tests and `npx vitest run` in `packages/agent-cli`. Expected: PASS. Commit: `feat(sandbox): setup, docs and packaging`.

### Task 9: Whole-suite check and handover

- [ ] **Step 1:** Run the full suites: `packages/server`, `packages/agent-cli`, `packages/web`, `packages/friend`, plus `pnpm -r exec tsc --noEmit` where configured. Expected: PASS apart from the known load-flaky tests, which are re-run alone and named in the report.
- [ ] **Step 2:** Run one end-to-end check against the real app: start Friend, ask for a Python calculation with Docker stopped, confirm the answer and `runner: "sandbox"`.
- [ ] **Step 3:** Report to the owner: measured package size, which languages passed Task 1, the limits, and that nothing is merged or published until they say so.
