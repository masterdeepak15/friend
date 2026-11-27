# Windows PCs: the assistant uses a Windows PC like a person

Status: awaiting owner approval. Size: a project. **Replaces** the PC agents design of 2026-11-25 (that file is marked superseded). Modelled on the open-source Windows-MCP (CursorTouch, MIT), rebuilt as Friend's own thing.

## Why

The owner wants the assistant to operate a Windows PC the way a person does: look at the screen, click, type, open apps, wait for things, run commands. Many PCs can be added from a plugin, the way Chrome control is a plugin. Each PC runs a small program (an .exe) that carries its own server details, signs in once, then stays connected, starts again after a restart, and keeps its own record of tasks and status.

## Today (found in the code and the Windows-MCP repo)

- `DeviceHub` keeps sockets of PCs that paired with `friend node`; a call goes to "the most recently connected" one, and the assistant cannot name a PC. Permissions are not stored per PC.
- Chrome control is a bundled MCP server run by Friend's connector hub (`connectors/chromePlugin.ts`), local to the Friend host.
- Windows-MCP: 25 tools (see Tools), a screenshot plus a numbered list of clickable elements (Windows UI Automation), a "desktop control" handoff (a countdown; the owner's own input takes control back). It needs Python 3.14, runs on the PC it controls, has no per-PC permissions, and sends anonymous telemetry by default. So we build our own on Friend's outbound connection.

## Goals

- **Windows PCs plugin**: list (name, online, status line, current task, last seen), Add PC, Download, Revoke, permissions, control on/off.
- **Add flow**: name the PC, download an .exe, run it, approve once (sign-in with device authorization and PKCE). It then stays connected, with no code to type.
- **The exe carries its details**: server address, PC name and enrollment id are inside the file.
- **Starts again after a restart** and reconnects by itself; survives a Friend restart too.
- **Control sessions (owner decision)**: one control session per PC at a time; several tasks can wait their turn; the status is always kept and always shown.
- **Like a human**: the assistant sees (snapshot with element numbers and a marked screenshot), acts (click, type, scroll, drag, shortcuts, apps), waits for what it expects, and checks the result. Movement is smooth, not a teleport.
- **Everything the Windows-MCP offers** (parity list under Tools), plus per-PC permissions and the audit trail.
- **SQLite on the PC** for its own data (settings, token, tasks, events, status).

## Non-goals

- No remote-desktop streaming product; screenshots are on demand.
- macOS and Linux agents: not in this project (the existing `friend node` stays for shell and files there).
- Not controlling games, secure desktop prompts (UAC) or windows of a higher privilege than the agent.
- No cloud relay of ours; the PC connects out to the owner's own Friend.
- No code signing in this project (see Risks).

## Anti-goals

- The AI clicking in a password manager, a bank, UAC or Windows Security, or approving its own critical action.
- A control session the owner cannot see or stop in one move.
- A new PC that can do anything before the owner chose permissions.
- A stolen token or exe working forever or for another PC.
- The AI typing or reading secrets into the audit trail.

## Approaches (my pick: A; the owner handed me the how)

- **A. One Windows exe made with Node's single-executable feature.** The agent is TypeScript in this repo (shares the protocol, zod and tests); built-in `node:sqlite` for its data; a long-lived PowerShell process with embedded C# does the Windows parts (UI Automation, SendInput, screenshots, windows, clipboard). Nothing to install on the PC (~90 MB). **Chosen.**
- B. A small C# exe built with the .NET Framework compiler that every Windows has. Tiny and native, but a second language and toolchain, no SQLite without a native DLL, and no shared tests with the server.
- C. Wrap the upstream Python Windows-MCP. Rejected: Python 3.14 on every PC, telemetry, no per-PC model, not "our own".

## The flow

1. **Add PC (screen)**: Plugins → Windows PCs → Add: a name and the permissions to start with (all off by default) → the server makes a pending PC and an enrollment id.
2. **Download**: the server builds the exe: a cached *template* (the agent bundled into Node's single executable for Windows x64) plus a small signed trailer appended to the file: `{ server address, pcId, pcName, enrollmentId, server fingerprint }`. Any host OS can do this (it only appends bytes). The template comes from a platform package `friend-pc-agent-win32-x64`, published with each release and fetched on first use into the data folder (my pick; the builder may choose another source).
3. **Install**: run the exe. It copies itself to `%LOCALAPPDATA%\Friend\pc-agent\`, registers a per-user Scheduled Task "Friend PC Agent" (at logon, restart on failure; it must run in the user's session, never as a service, because a service cannot see the desktop), starts, and opens the approval page.
4. **First sign-in (device authorization with PKCE, as in the OAuth design)**: the agent makes a `code_verifier` and sends its S256 `code_challenge` with the enrollment id; the server returns a `user_code`, a `device_code` and a link; the owner opens the link (on the screen or the phone), logs in, sees "Add PC <name>: Windows 11, host, ip", picks permissions and approves with the PIN. The agent polls with the verifier and gets a short access token and a rotating refresh token. They are stored in the agent's SQLite sealed with Windows DPAPI (current user).
5. **Always connected**: the agent opens an outbound WSS connection with the access token, sends `hello {os, host, agent version}`, reconnects with backoff, rotates the token. **Revoke** closes the socket at once and the refresh fails. The enrollment id cannot be used twice.

## Control sessions, tasks and status (owner decision; my reading marked)

- **Session (a lease)**: only one at a time per PC. Starting one is how input tools get enabled; screen capture and control are covered by that start (the owner starts it on the screen, by voice or on the phone, with an optional time limit). The approval says which PC.
- **Always visible on the PC**: a thin coloured border and a small banner "Friend is controlling this PC: <task>", and a tray icon. Both are always topmost.
- **The owner's hands win**: any real mouse or keyboard input pauses the session at once (state "paused by you"); the assistant must ask again, and the agent counts down 3 seconds before it moves anything. A hotkey (default Ctrl+Alt+Shift+Esc) ends the session. A session ends on idle timeout, on disconnect, on a screen lock, and on revoke.
- **Tasks (my reading of "multi task")**: the assistant queues tasks on a PC ("update the report", "install the printer"); one runs at a time under the one session; the rest wait with their state. Tasks and their steps are kept in the agent's SQLite and survive a restart (a task that was running comes back as *paused*, and never clicks again without a new session).
- **Status (my reading of "holding always status")**: the agent keeps one status record: `offline | idle | controlling | paused | waiting for owner | error`, the current task, the last action and the time. It is written to SQLite on every change, pushed to the server at once and on a 15 second heartbeat, and shown in the plugin and on the PC. The server keeps the last status while a PC is offline.

## Tools for the assistant

All take `pc` (the PC's name). With one PC online it may be left out; with several and no name the assistant asks which. An offline PC: it says so.

- **See**: `pc.snapshot` (screenshot with element numbers, the list of clickable and typeable elements, open windows, scrollable areas; options: vision, region, display), `pc.screenshot`, `pc.displays`.
- **Act**: `pc.click` (by element number or position; left, right, middle; double; hover), `pc.type` (into an element; clear first; press Enter; checks the text arrived), `pc.scroll`, `pc.move` (move and drag), `pc.shortcut`, `pc.multi_select`, `pc.multi_edit`, `pc.app` (launch by name or path, switch, resize, move, close), `pc.clipboard`.
- **Wait**: `pc.wait`, `pc.wait_for` (a window, text, an element present or enabled, focus; with a timeout).
- **System**: `pc.shell` (PowerShell), `pc.files` (read, write, copy, move, delete, list, search), `pc.process` (list, end), `pc.registry`, `pc.notify`.
- **Control and tasks**: `pc.control` (start, stop, status, with a time limit), `pc.tasks` (add, list, cancel), `pc.list` (the PCs and their status).
- Not copied: Windows-MCP's `Scrape` (Friend already has `web.read` with its own safety), telemetry.
- Human-like: moves follow a short eased path (150 to 400 ms), keys have small natural gaps, and a step can ask for a fresh snapshot after the action so the assistant sees the result.

## Permissions per PC (from the old design, kept)

Set by the owner per PC, held on the server, enforced on the server and again on the PC: **Control** (off or on), **Shell**, **Files** (off, read, read and write, with folders), **Registry**, **Processes**, **Screen capture**. A new PC starts with all off.

**Critical floor (fixed, always asks, on any PC):** delete or overwrite files, destructive shell commands, registry writes, installing or uninstalling software, power and restart, privilege changes, and a click on a button or menu whose name says delete, remove, uninstall, erase, format, pay, purchase, buy, send money, transfer, confirm order, factory reset. The approval card names the PC and shows the exact command or the window title, the element and a crop of the screen. The owner can add patterns; the floor cannot be turned off.

**Never clicked (fixed deny list, the owner may extend it):** password managers (1Password, Bitwarden, KeePass, LastPass), UAC and Windows Security prompts, banking and payment windows by title words. Outside the allowed folders: refused, never asked.

## Server

- Tables: `pcs {id, name, os, host, perms_json, status_json, last_seen, revoked, created}`, `pc_enroll {id, pc_id, code_hash, challenge, expires, used}`, `pc_tokens {id, pc_id, refresh_hash, rotated_at}`.
- `DeviceHub` serves many PCs by id and name (the "most recent" rule goes away); the assistant's device tools gain `pc`.
- Endpoints: start enrollment, approval page, poll for the token (PKCE checked), refresh, revoke, download the exe. All owner-gated, rate limited, audited.
- Audit: `pc.added`, `pc.approved`, `pc.revoked`, `pc.permissions`, `pc.control.start|stop|paused`, and a line for each tool call with the PC name, the tool, the window title and the outcome. Typed text is recorded as a length only.

## The agent (TypeScript, in `packages/pc-agent`)

`store` (`node:sqlite`: config, sealed token, tasks, events, status) · `link` (WSS, backoff, token refresh) · `control` (lease state machine, input watcher, hotkey, banner) · `tasks` (queue, resume as paused) · `tools` (the list above) · `helper` (one PowerShell process with embedded C#, JSON lines over stdio: UI Automation tree, SendInput, screenshots, windows, clipboard, DPI) · `guard` (deny list, critical floor, permissions copy) · `install` (copy, Scheduled Task, uninstall).

## Risks and limits (honest)

- **Unsigned exe**: Windows SmartScreen shows "unknown publisher" and some antivirus tools dislike single-executable apps. A code-signing certificate is a later step (paid); the guide says how to proceed.
- **SQLite in a single executable** is not confirmed by the docs: **Task 0 is a spike**; the fallback is a WebAssembly SQLite.
- UAC and elevated windows cannot be controlled unless the agent runs elevated (not by default; a later option). A locked screen or a minimized remote-desktop window cannot be captured.
- Electron and Chromium apps give a huge element tree: words are merged and there is a size cap. Text selection inside a paragraph and games are not supported (same as Windows-MCP).
- The helper needs Windows PowerShell 5.1 (on every Windows 10 and 11).

## Testing (what the plan must cover)

- Enrollment: PKCE success, wrong verifier, expired and reused codes, revoke at once, token rotation.
- The exe builder: the trailer round trip, a changed trailer is refused, the missing-template message.
- Control state machine with a fake clock and fake input: one session at a time, user input pauses, countdown, hotkey, idle timeout, disconnect and revoke end it, tasks resume as paused.
- Guard: deny list, critical words, folders, per-PC permissions, the PC re-checks what the server allowed.
- Tools through a fake helper; the assistant picks the PC by name and asks when unclear.
- A real Windows smoke test (skipped on other systems): open Notepad, snapshot, type, verify the text, close it.
- Server and screens: PC list, status, approval page, audit and coverage tests (every new tool and endpoint leaves an entry).

## Left to the builder

Message shapes on the socket, the helper's C# internals, where the template package is published and fetched, the banner and border drawing, exact wording of the guide.

## Questions for the owner

1. My readings of "1 control session and multi task with holding always status" (above). Right?
2. The old `friend node` pairing stays for macOS and Linux shell and files; Windows PCs use the new agent. OK?
3. An unsigned exe at first (a SmartScreen warning). OK for now?
