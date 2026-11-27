# Windows PCs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the owner chose inline execution and asked for a release when done). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add many Windows PCs from a plugin; each runs an agent installed by one PowerShell command (signed official Node plus our `agent.js`), signs in once with device authorization and PKCE, stays connected, and lets the assistant operate the PC like a person (see, click, type, wait, run, files) and drive terminal sessions such as Claude Code, under control sessions, tasks, status and per-PC permissions.

**Architecture:** `@friend/protocol` gets PC schemas and `pc.*` tool definitions. The server gets `PcStore` (sqlite), enrollment endpoints, a multi-PC `PcHub`, a `guard`, and routes `pc.*` tools by PC name. A new package `packages/pc-agent` holds the agent (store on `node:sqlite`, link, control lease, tasks, tools, terminal sessions) and a PowerShell helper with embedded C#. The installer is a generated PowerShell command. The web gets a Windows PCs panel.

**Tech Stack:** TypeScript ESM, zod, fastify, ws, better-sqlite3 (server), `node:sqlite` (agent), esbuild (agent bundle), `@xterm/headless` (terminal screen), PowerShell 5.1 with C# `Add-Type` (UI Automation, SendInput, GDI+, ConPTY), React + vitest.

**Spec:** `docs/superpowers/specs/2026-11-27-windows-pcs-design.md`

## Global Constraints

- Windows 10/11 x64 PCs only; the agent runs in the user's session, never as a service; per-user Scheduled Task "Friend PC Agent".
- No unsigned executable is ever downloaded: only the official `node.exe` (Authenticode publisher "OpenJS Foundation", pinned version, SHA-256 checked) and `agent.js` (SHA-256 checked).
- A PC starts with every permission off. Critical floor and deny list are fixed (the owner may only add patterns). Outside allowed folders: refused, never asked.
- One control session per PC at a time; real user input pauses it; hotkey Ctrl+Alt+Shift+Esc ends it; a restart brings a running task back as paused.
- Typed text is audited as a length only; tokens are stored hashed on the server and DPAPI-sealed on the PC.
- Tools take `pc` (name); ambiguous or unknown name: ask which; offline: say so.
- Commit trailers on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_012ETJR1cqrP2QEgcMSWVVDG`.

## Review Focus

- Enrollment: a used, expired or guessed code; a wrong PKCE verifier; the same PC approved twice.
- Revoke while a control session or a terminal session is running: everything stops, the socket closes.
- The owner types while the assistant is clicking: the lease pauses before the next click.
- A terminal prompt that is destructive: the assistant must not answer it alone.
- Two assistant tasks for one PC: one runs, one waits; a restart in the middle resumes paused.
- The PC offline when a tool is called; two PCs with similar names.
- A huge UI tree (Electron app): capped, not a hang.

---

### Task 1: Protocol (PC schemas, tools, link messages)

**Files:** Create `packages/protocol/src/pc.ts`, `packages/protocol/src/pc.test.ts`; Modify `packages/protocol/src/index.ts`, `packages/protocol/src/tools.ts`.

**Interfaces — Produces:** `PcPermissions {control, screen, shell, registry, process: boolean; files: "off"|"read"|"write"; folders: string[]}`, `PcStatusState = offline|idle|controlling|paused|waiting|error`, `PcStatus {state, task?: string, last?: string, at: number, sessions?: number}`, link messages `PcUp = hello | tool.result | tool.error | status | human.input | lease.ended`, `PcDown = tool.exec {id, tool, args, lease?} | lease.start {id, minutes?} | lease.end | revoke | update {url, sha256}`, `PC_TOOL_NAMES`, tool defs `pc.list pc.control pc.tasks pc.snapshot pc.screenshot pc.displays pc.click pc.type pc.scroll pc.move pc.shortcut pc.multi_select pc.multi_edit pc.app pc.clipboard pc.wait pc.wait_for pc.shell pc.files pc.process pc.registry pc.notify pc.term.open pc.term.list pc.term.read pc.term.send pc.term.wait pc.term.close pc.claude.sessions` (target `gateway`; reads T0, control and input T1, shell/files/registry/process T2, delete-like T3), `describeCall` lines.

- [ ] **Step 1: Failing tests** in `pc.test.ts`: every name in `PC_TOOL_NAMES` has a def with `target:"gateway"` and a `pc` string argument that is optional; input tools (`pc.click`, `pc.type`, …) are not T0; `PcPermissions` default is all off; `PcDown`/`PcUp` accept valid messages and refuse unknown ones; `pc.term.send` accepts `{id, text}` and `{id, keys:["Down","Enter"]}` and refuses neither; `describeCall("pc.shell", {pc:"Office", command:"dir"})` names the PC.
- [ ] **Step 2: Run** `pnpm --filter @friend/protocol vitest run src/pc.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `pc.ts`, the tool defs in `tools.ts` (descriptions teach: look with `pc.snapshot`, act by element number, wait, verify; ask which PC), `describeCall` lines.
- [ ] **Step 4: Run** the protocol suite — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc): PC schemas, link messages and tool definitions`.

### Task 2: Server store and enrollment (device authorization with PKCE)

**Files:** Create `packages/server/src/pc/store.ts`, `enroll.ts`, `store.test.ts`, `enroll.test.ts`; Modify `migrations.ts` (tables `pcs`, `pc_enroll`, `pc_tokens`), `app.ts` (routes).

**Interfaces — Produces:** `PcStore(db)`: `create({name, permissions}): {pc, enrollmentId}`, `get(id)`, `byName(name)`, `list()`, `setPermissions`, `setStatus`, `touch`, `revoke(id)`. `Enroll(store, clock)`: `start({enrollmentId, challenge, os, host}): {deviceCode, userCode, verifyUrl, interval, expiresIn}`, `lookup(userCode)`, `approve(userCode, {permissions, name?})`, `poll({deviceCode, verifier}): {pending}|{access, refresh, pcId}|{error}`, `refresh(refreshToken): {access, refresh}` (rotating; a reused old refresh token revokes the PC), `verifyAccess(token): pcId|null`. Routes: `POST /api/pc/enroll/start`, `GET /api/pc/enroll/:userCode` (owner, shows PC and host), `POST /api/pc/enroll/:userCode/approve` (owner, PIN), `POST /api/pc/enroll/token`, `POST /api/pc/token/refresh`, `POST /api/pc/:id/revoke`.

- [ ] **Step 1: Failing tests:** create → start → approve → poll returns tokens and the PC is online-capable; wrong verifier refused; code expires after 10 minutes (fake clock); a used code refused; polling before approval returns pending with the interval; refresh rotates and the old refresh token, used again, revokes the PC; revoke makes `verifyAccess` null; tokens stored hashed (the db never contains them); names unique, case-insensitive; routes owner-gated (a guest and an anonymous call refused), rate limited, audited (`pc.added`, `pc.approved`, `pc.revoked`).
- [ ] **Step 2: Run** `pnpm --filter @friend/server vitest run src/pc` — Expected: FAIL.
- [ ] **Step 3: Implement** store, enroll and routes (follow the OAuth device code pattern already in `oauth/`; reuse PIN verification and the approval page conventions).
- [ ] **Step 4: Run** the same tests and `src/audit` — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc): PC store and device authorization with PKCE`.

### Task 3: Server hub, guard and tool routing

**Files:** Create `packages/server/src/pc/hub.ts`, `guard.ts`, `tools.ts` and tests; Modify `app.ts` (WSS route `/pc`, hub wiring, status broadcast to screens, `pc` ui messages), `agent/loop.ts` (`pc.*` handler, approvals naming the PC), `agent/guide.ts`, `agent/prompt.ts`.

**Interfaces — Produces:** `PcHub`: `attach(pcId, ws)`, `online(): PcInfo[]`, `resolve(name?): {pc}|{ask: string}|{error}`, `exec(pcId, tool, args, timeoutMs, lease?)`, `startLease`, `endLease`, `status(pcId)`, `onChange`. `guard.check(tool, args, ctx): "allow"|"ask"|"deny" + reason` using permissions, folders, critical words, deny list, extra owner patterns. `runPcTool(name, args, deps): ToolResult`.

- [ ] **Step 1: Failing tests:** `resolve` with one PC online and no name picks it, with several asks which (lists names), unknown or offline gives a sentence; permissions off → deny with the reason; critical click label ("Delete account", "Pay now") → ask; deny-list window ("1Password", "User Account Control") → deny; path outside folders → deny; revoke closes the socket and ends the lease; lease lifecycle (one at a time, a second start refused with who has it); a call on a PC with an ended lease for an input tool is refused with "start a control session"; status changes reach `onChange`; audit line per call with PC name and a typed-text length only; owner only.
- [ ] **Step 2: Run** `pnpm --filter @friend/server vitest run src/pc` — Expected: FAIL.
- [ ] **Step 3: Implement** the hub (sockets by pc id; messages validated with `PcUp`), the guard (critical floor as a fixed list plus owner extras), the tool runner and the loop handler; approvals show PC name and the exact command, window title or screen text.
- [ ] **Step 4: Run** full server suite — Expected: pass (known load-flaky: real-Chrome `browser/hub.test.ts`, python sandbox, Claude Code timing: rerun alone).
- [ ] **Step 5: Commit** `feat(pc): hub, guard and pc tools`.

### Task 4: Agent core (store, link, control lease, tasks, status)

**Files:** Create package `packages/pc-agent` (`package.json`, `tsconfig.json`, `src/store.ts`, `link.ts`, `control.ts`, `tasks.ts`, `status.ts`, `agent.ts`, tests).

**Interfaces — Produces:** `AgentStore(path)` on `node:sqlite` (`getConfig/setConfig`, `sealed token get/set`, `tasks`, `events`, `status`); `Link({server, getToken, refresh, onMessage})` with backoff and token refresh; `Control` (state machine `idle|controlling|paused`, `start(minutes?)`, `humanInput()`, `hotkey()`, `tick(now)`, `resumeCountdown 3s`, idle timeout, `end(reason)`); `Tasks` (queue, one running, `resumeAfterRestart()` marks running as paused); `Status` (one record, writes to store, pushes on change, heartbeat 15 s).

- [ ] **Step 1: Failing tests (fake clock, fake socket):** lease: one at a time; human input pauses and the next input tool is refused until resumed with the countdown; hotkey ends; idle timeout ends; disconnect ends; tasks: queued tasks run one at a time in order, a restart marks the running task paused and nothing clicks until a new lease; status record updates on every change and a heartbeat goes out every 15 s; store: values survive reopening, the sealed token is not readable as plain text in the file; link: reconnects with backoff, refreshes an expired token once, stops on revoke.
- [ ] **Step 2: Run** `pnpm --filter @friend/pc-agent vitest run` — Expected: FAIL.
- [ ] **Step 3: Implement** the modules (the DPAPI seal goes through the helper; tests use a fake sealer).
- [ ] **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc-agent): store, link, control lease, tasks and status`.

### Task 5: Windows helper (PowerShell and C#)

**Files:** Create `packages/pc-agent/helper/helper.ps1` (embeds C#), `src/helper.ts` (spawns it, JSON lines, timeouts, restart), `src/helper.test.ts`, `src/helper.win.test.ts` (Windows only).

**Interfaces — Produces:** `Helper.call(op, args): Promise<unknown>` with ops: `snapshot {region?, display?, vision?}` (windows, element list with numbers, scrollable areas, marked screenshot as base64 png, capped), `screenshot`, `displays`, `click {x,y|label, button, clicks}`, `type {text, label?, clear?, enter?}`, `scroll`, `move {x,y, drag?, from?}`, `shortcut`, `app {action, name|path}`, `clipboard {get|set}`, `focus`, `wait_for`, `seal/unseal` (DPAPI), `input_events` (a stream telling when the real user moves the mouse or types, ignoring our own synthetic input), `overlay {show, text}` (border and banner), `term.*` (Task 7).

- [ ] **Step 1: Failing tests:** `helper.test.ts` with a fake child process: requests get ids and matching responses, a timeout rejects and restarts the helper, a crash rejects pending calls. `helper.win.test.ts` (skipped unless `process.platform === "win32"`): open Notepad, `snapshot` finds its edit control, `type` "hello", read back the text, `app close`; `displays` returns at least one display; seal then unseal round-trips.
- [ ] **Step 2: Run** `pnpm --filter @friend/pc-agent vitest run src/helper` — Expected: FAIL.
- [ ] **Step 3: Implement** the helper (UI Automation tree walk with a node cap and a time cap, word merging, SendInput with eased mouse paths of 150 to 400 ms and natural key gaps, GDI+ screenshot with element number marks, DPAPI, low-level hooks for human input with a flag to ignore injected events, topmost overlay window).
- [ ] **Step 4: Run** the tests on this Windows PC — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc-agent): Windows helper for UI Automation, input, screenshots and sealing`.

### Task 6: Agent tools and guard on the PC

**Files:** Create `packages/pc-agent/src/tools.ts`, `guard.ts`, tests.

**Interfaces — Consumes:** `Helper`, `Control`, `Tasks`, `PcPermissions`. **Produces:** `runTool(name, args, ctx): ToolResult` for every `pc.*` tool except `term` and `claude`; a second guard copy (deny list, critical words, folders, permissions) that re-checks what the server allowed; `pc.shell` (PowerShell with timeout and output cap), `pc.files`, `pc.process`, `pc.registry`, `pc.notify`.

- [ ] **Step 1: Failing tests (fake helper):** input tools refused without a lease; permission off refused; deny-list window refused; critical label returns "needs approval"; shell, files (folders and read/write), process and registry honour permissions; `pc.type` fails with an error when the text did not arrive; `pc.snapshot` output is capped; every call is written to the store's events with the tool, window title and outcome and a typed-text length only.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc-agent): tools and the PC-side guard`.

### Task 7: Terminal sessions (ConPTY, screen, Claude Code)

**Files:** Create `packages/pc-agent/src/term.ts`, `claude.ts`, tests; extend `helper.ps1` with ConPTY (`CreatePseudoConsole`) ops `term.open/write/resize/close` and an output event stream.

**Interfaces — Produces:** `Terms`: `open({cwd, command, args}) → id`, `read(id) → {screen, cursor, state: "busy"|"idle"|"prompt", options?: string[]}`, `send(id, {text?, keys?})` with named keys (Enter, Esc, Tab, Up, Down, Left, Right, Backspace, Ctrl+C, …), `wait(id, {idle?, text?, timeout})`, `close(id)`, `list()`. `claudeSessions(project): {id, summary, at}[]` from `~/.claude/projects/<encoded project>/*.jsonl`. The prompt detector knows Claude Code's permission and menu screens and reports the visible options and whether the prompt looks destructive.

- [ ] **Step 1: Failing tests:** feed recorded VT output (a Claude Code menu with options, a busy spinner, a plain shell prompt) into the emulator: `read` gives the screen text, `state`, the options and the destructive flag; `send` maps keys to the right byte sequences (arrow keys, Enter, Ctrl+C); `wait` for idle and for text with a fake clock; `claudeSessions` reads fixture jsonl files and sorts newest first with a summary; `open` is refused outside allowed folders or without the shell permission; a destructive prompt makes `send` return "needs approval" unless an approval was passed in. Windows-only smoke: open `cmd`, send `echo hi`, read it back.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc-agent): terminal sessions and Claude Code control`.

### Task 8: Agent entry, bundle, installer and self-update

**Files:** Create `packages/pc-agent/src/main.ts`, `install.ts`, `scripts/bundle.mjs`; server `pc/installer.ts`, `pc/installer.test.ts`; routes `GET /api/pc/agent.js` (hash header), `GET /api/pc/install.ps1?enrollment=…`, `GET /api/pc/install.cmd?enrollment=…`; `packages/friend/scripts/bundle.mjs` copies `agent.js` and the helper into the npm package.

**Interfaces — Produces:** `installScript({server, name, enrollmentId, agentSha256, nodeVersion, nodeSha256}): string`, `installCommand(...)` (the one-liner), `installCmd(...)` (a `.cmd` wrapper), agent `--uninstall`, self-update (the server tells the agent a new `agent.js` hash; the agent downloads, checks, swaps and restarts).

- [ ] **Step 1: Failing tests:** the script contains the server address, name, enrollment id and both hashes, checks the Authenticode publisher "OpenJS Foundation" and refuses a wrong signature or hash, is safe to run twice (updates in place), registers a per-user logon task with restart on failure, and has an uninstall; the one-liner uses `-ExecutionPolicy Bypass` for that run only; `install.ps1` and `install.cmd` need a valid unexpired enrollment id and are rate limited; `agent.js` is served with its SHA-256; the bundle builds and its hash matches the served one.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc): installer command, agent bundle and self-update`.

### Task 9: The plugin screen (Windows PCs)

**Files:** Create `packages/web/src/plugins/WindowsPcsPanel.tsx`, `pcsApi.ts`, tests; Modify the Plugins screen to list it, `store.ts` (pc status messages), the approval page for enrollment (reuse the OAuth approval page pattern).

- [ ] **Step 1: Failing tests:** list shows name, online dot, status line, current task and last seen; Add PC asks for a name and permission switches (all off) and then shows the command with a Copy button and a "Download .cmd" link; the approval page shows the PC name and host and approves with the PIN; the permissions editor saves; control start and stop buttons with a time limit; Revoke asks first; the terminal card shows live screen text.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm --filter @friend/web vitest run src/plugins` and typecheck — Expected: pass.
- [ ] **Step 5: Commit** `feat(pc): the Windows PCs plugin screen`.

### Task 10: Guides, full verification, release 0.1.97

**Files:** Create `docs/guides/windows-pcs.md`; Modify `README.md`, `agent/guide.ts` (topic `pcs`), `packages/friend/package.json` (0.1.97, new dependency list if the package test requires).

- [ ] **Step 1:** Write the guide (add a PC, the command, what each permission allows, control sessions and the hotkey, terminal sessions and Claude Code, SmartScreen and antivirus notes, uninstall).
- [ ] **Step 2: Run** `pnpm -r --no-sort typecheck` and the suites — Expected: pass apart from known load-flaky tests, each re-run alone and passing.
- [ ] **Step 3: Real run on this Windows PC:** build the agent bundle, enroll a PC against a throwaway Friend, take a control session, open Notepad, type, and open a `cmd` terminal session and read it; screenshot the plugin screen; fix what looks wrong.
- [ ] **Step 4:** bump to 0.1.97, commit `chore: release 0.1.97`, `pnpm package`, `cd packages/friend && npm publish`, `git push origin main`.
