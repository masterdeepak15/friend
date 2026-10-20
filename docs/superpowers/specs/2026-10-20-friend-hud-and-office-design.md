# Friend: Orbital HUD and the Office (design)

Date: 2026-10-20. Status: draft for the owner's review.

## 1. Purpose

Friend is a self-hosted JARVIS-style assistant. Two things are wanted, in this order:

1. **Orbital HUD.** The screen stops being "an orb and a few floating cards" and becomes a sci-fi heads-up display. Every region of the screen is an instrument with one meaning, its own shape and its own motion.
2. **The Office.** Friend acts as the CEO. When the owner asks for something big, Friend hires Claude Code workers (coder, tester, reviewer…), gives them tickets, and the owner watches and steers them live on the HUD. Inspired by Paperclip (https://github.com/paperclipai/paperclip), but native to Friend: no second app, no database server, no cost beyond the Claude Code subscription already in use.

### What the owner said (their words, not assumptions)
- "Friend is the boss of an office; we are already the boss of Friend." The owner talks to Friend; Friend manages the workers.
- "Each agent: we can see from the UI what they are doing." Live visibility is a requirement.
- "Not a normal UI. Sci-fi HUD, each component a widget with meaning." "Cards all the same" was rejected: shapes, glow, running lines and animation are wanted.
- Option B, **Orbital**, chosen after mockups, then asked to be clickable.
- Start with one project and a small team ("build mode"), then grow toward several projects, routines and budgets per agent.
- Standing principles: **free only**; **configurable, not hardcoded**.

### Assumptions (correct me)
- The HUD is for the desktop browser first; phone and tablet get a reduced layout, not the full orbit.
- The classic screen stays available as a setting, so nothing the owner uses today is lost.
- Workers run on the PC that runs Friend, with the Claude Code program already installed and signed in.

## 2. Scope and decomposition

Two sub-projects, each with its own plan:

| # | Sub-project | Delivers |
|---|---|---|
| 1 | **Orbital HUD shell** | New screen layout, widget system, animation kit, real data feeds, click-to-expand. Useful on its own. |
| 2 | **Office** | Projects, workers, tickets, runner, Friend's delegation tools, and the Office widgets (workers on the orbit, ticket cells, worker feed, approvals, budget). Needs sub-project 1. |

Sub-project 1 is specified in full below. Sub-project 2 is specified at design level (§5); its detailed plan is written after the shell exists.

Out of scope for now: multiple companies, cron routines, other agent programs (Codex, Gemini), a 3D renderer, any paid service, remote workers.

## 3. Orbital HUD shell

### 3.1 Layout
A full-screen scene. The centre is always clear for the orb and its captions.

- **Centre:** the existing orb (`Presence`), unchanged, with HUD rings drawn around it: a rotating tick ring, a counter-rotating dashed ring and a **segmented usage ring** (60 segments, filled to today's usage relative to the owner's busiest day of the last 30; in the HUD shell this is today's usage against the busiest day; §8 found that headless Claude Code does report the real five-hour window, which a later change feeds into the ring).
- **Orbit:** a ring of hexagon "nodes" around the orb at radius ≈ 0.33 × the smaller screen side. In sub-project 1 the nodes are the owner's **quick-launch items** (today's launcher), so the orbit is useful before the Office exists; in sub-project 2 they become the workers. Links from the orb to each node are dashed lines with data flowing along them.
- **Zones** around the edge hold the widgets: top bar, left rail (top, middle, bottom), right rail (top, middle, bottom), bottom command bar. Each zone is an anchor with a size range, not a fixed pixel box, so it follows the window.
- Layout maths (orbit radius, node angles, zone anchors) lives in one pure module with unit tests; no layout numbers are scattered through components.

### 3.2 Widgets: one meaning, one shape, one motion
A widget is a registry entry: `id`, `title`, `zone`, `shape`, `minSize`, `data` (what it reads), `expand` (what a click shows) and an `enabled` default. Shapes are deliberately different:

| Widget | Shape and motion | Data |
|---|---|---|
| Top bar | notched line with a running light, title, clock, link state | existing status, clock |
| System | semicircle arc gauge (CPU) with inner arc (RAM) | new server stats feed |
| Voice | spectrum bars | existing voice level |
| Network | pulse line with a running light | new server stats feed |
| Worker feed | chamfered terminal with scrolling lines and a running border light | agent activity now; worker streams later |
| Devices | radar with a rotating sweep and blinking blips | connected devices |
| Tickets | hexagon cells coloured by status | empty state until the Office exists |
| Budget | three concentric rings | existing usage tracking, per worker later |
| Approval | octagon with warning triangle, pulsing orange; APPROVE / DENY | existing approval flow |
| Command bar | slanted bar with a blinking cursor, hold-to-talk hint | existing command bar |

Orange is reserved for "needs the owner" (approvals, waiting workers, alerts). Cyan is the base colour; green means running. Colours come from the existing mood accent so the owner's theme still applies.

Existing panels (chat, tasks, status, clock, music, launcher) are folded into the same registry and rendered in HUD frames; their behaviour does not change. **Agent-placed objects** (charts, pictures the assistant puts on the stage) keep working: they appear in a free "stage tray" region, or expanded in the centre when the assistant asks for focus. They are never hidden behind widgets.

### 3.3 Interaction
- **Click or tap any widget or node** expands it into the centre area (the stage already has a "focus" scene). Esc, a click outside, or the close mark returns to the HUD. One expanded item at a time.
- Nodes show a hover/focus state and a short tooltip. Everything is reachable by keyboard (Tab order follows zones; Enter expands; Esc closes) and has an accessible name.
- Widgets can still be switched on or off, and the owner's choices are remembered per device.
- Long-press to talk and the message bar behave as today.

### 3.4 Density and settings (configurable, not hardcoded)
New setting `hud`:
- `layout`: `classic` (today's screen, the default until the owner switches) or `orbital`.
- `density`: `calm` (orb, orbit and bottom bar only), `standard`, `full`.
- `widgets`: per-widget on/off.
- `animations`: reuses the existing animations switch; when off, or when the OS asks for reduced motion, every loop stops and values still update.
Settings appear in the existing Settings screen and can also be changed by the assistant through the existing `settings.set` path with PIN approval. The existing views (Minimal, Companion, Workspace) map to densities.

### 3.5 Data feeds
- Reuse what exists: usage (`usage.ts`), voice level, approval, status, clock, launcher, connected devices.
- New: a small **stats feed** from the server (CPU and RAM from the OS module; network throughput of the Friend process or LAN adapter), sent about once a second only while a HUD widget that needs it is visible. No new dependency.
- The web store keeps these as slow, throttled state; animation never causes per-frame React renders.

### 3.6 Rendering and performance
- Frames, gauges, radar and rings are inline SVG with CSS animations (transform, opacity, dash offset). No canvas, WebGL or library is added; the orb keeps its current renderer.
- All loops pause when the tab is hidden. Glow uses one shared SVG filter. A frame-time check on a mid-range PC at full density must hold 60 fps for the HUD layer; if a widget misses it, its motion is simplified.
- Phone and narrow tablet: no orbit. The nodes become a horizontal chip row, widgets stack in a swipeable strip, the orb and command bar stay. Touch controls remain.

### 3.7 Safety and compatibility
- No change to authentication, trust tiers, approvals or the voice pipeline.
- `classic` stays available and is covered by the existing tests.
- A widget that throws is isolated (same `Safe` boundary the stage uses) and shows nothing rather than breaking the screen.

### 3.8 Testing
- Unit: layout maths, density and preset mapping, widget registry, stats feed throttling.
- Component: each widget renders its states (empty, normal, warning) and expands on click and on Enter; Esc closes; reduced motion stops loops.
- Integration: the existing stage tests keep passing in `classic`; new app tests cover `orbital`.
- Visual check: screenshots at 1920×1080, 1366×768 and a phone width, reviewed against the approved mockup (`.superpowers/brainstorm/…/orbital-v2.html`).

## 4. Order of work for sub-project 1
1. Layout maths and widget registry, with the `hud` setting.
2. HUD frame and animation kit (shared SVG shapes, running-light, glow).
3. Centre rings, orbit and links.
4. Widgets one by one, starting with those using existing data (usage, voice, approval, status, clock, command bar), then the stats feed (system, network).
5. Click-to-expand and keyboard.
6. Phone layout, reduced motion, settings screen, README.

## 5. The Office (design level)

### 5.1 Concepts
- **Project:** a folder on the PC plus a name and a goal. One active project in v1.
- **Worker:** a role (coder, tester, reviewer, architect or custom), its instructions, model and permission level. Friend hires a worker by creating one; the owner can edit or fire them in Settings.
- **Ticket:** title, description, status (todo, doing, review, done, blocked), assignee, project, and a log of what happened.
- **Run:** one execution of a worker on a ticket.

Friend is the manager: it breaks a goal into tickets, assigns them, reads results, and reports back by voice and chat. Friend itself never writes the project's code; workers do.

### 5.2 Runner
- Each run is a headless Claude Code process: `claude -p --input-format stream-json --output-format stream-json --verbose`, started with the project folder as its working directory, using the same process wrapper Friend already uses for its own Claude Code provider (`provider/claude-code/process.ts`, `cross-spawn`). Uses the existing subscription; free.
- Sessions are resumed per worker so a worker keeps context across tickets.
- Output events are parsed into a live feed (messages, tool calls, file edits, usage) stored with the ticket and pushed to the HUD.
- A **concurrency cap** (setting, default 2) respects subscription limits; extra tickets wait.

### 5.3 Friend's tools (new)
`office.hire`, `office.assign`, `office.status`, `office.stop`, `office.say` (send a worker a message). Starting a worker, and any change to a project folder's permissions, is a tier that asks the owner first. Guests and household members cannot use them (owner only).

### 5.4 Safety
- Each worker is fenced to its project folder; the tool allow-list is explicit per role. Reading and editing in the folder is allowed; installing packages, running shell commands outside a fixed allow-list, network and anything outside the folder need the owner's approval, shown as the orange Approval widget. Whether Claude Code's headless mode can ask through Friend (a permission-prompt tool) is **to be verified in the plan**; if not, those actions are denied and reported instead.
- Kill switch: stop one worker or all, from the HUD, by voice, or by Esc menu.
- Budgets: per-worker and total caps taken from the usage in the event stream; at the cap the worker pauses and asks the owner.
- Every start, stop, approval and denial is written to the audit log.

### 5.5 HUD widgets for the Office
- **Orbit nodes:** one hexagon per worker (running, waiting, idle), plus a "+" node to hire. Clicking a node expands that worker's live stream.
- **Tickets:** hex cells by status; clicking expands the full ticket board.
- **Worker feed, Approval, Budget:** as in §3.2, now fed by real data.
- Voice: "maya, how is the landing page going?", "stop the tester", "approve".

### 5.6 Growing toward several projects
Later: several projects at once, per-worker budgets and schedules, routines, an org chart view. The data model above already carries `project` on every ticket and run, so this is additive.

## 6. Risks and open questions
- **Subscription limits.** Several workers share one usage window. Mitigation: concurrency cap, usage ring, budgets.
- **Headless permissions.** Needs verification (§5.4).
- **Windows process handling.** Already solved for the provider (`cross-spawn`, no shell); reuse it.
- **Performance** of many animated SVG widgets on weak machines. Mitigation: density levels, reduced motion, per-widget simplification.
- **Scope creep.** The Office is a separate plan; the shell must be useful alone.

## 7. Success criteria
- The orbital screen at 1920×1080 matches the approved mockup in structure: clear centre, usage ring, orbit with flowing links, varied animated widgets, and uses the whole screen.
- Clicking any node or widget expands it; Esc returns; keyboard works.
- Calm, standard and full density work; reduced motion stops every loop.
- Classic layout is unchanged and its tests pass.
- (Office) The owner says "build me a landing page"; Friend creates tickets and hires workers; the HUD shows them working live; an approval appears as the orange widget; the owner can stop any worker.

## 8. Spike findings (2026-10-20, verified on Claude Code 2.1.304)

A throwaway spike ran real headless workers (`claude -p --input-format stream-json --output-format stream-json --verbose`) in scratch folders, with a stand-in approval server. What is now known, not assumed:

- **Streaming works.** Events: `system/init` (session id, model, working folder, tool count, MCP status), `stream_event` partials (live text), `assistant` (tool calls), `user` (tool results), `rate_limit_event`, and a final `result` (turns, duration, token usage, notional cost, `permission_denials`, session id). A cold start takes about 7 to 8 seconds before the first event, so the HUD shows "starting" for a worker.
- **Asking Friend first works** (`--permission-prompt-tool`). Claude Code calls an MCP tool before any action it would otherwise ask about; the answer `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny","message":…}` is honoured, and a denial's message reaches the worker, which reports it honestly and does not try to get round it. The "risky action" risk of §6 is closed.
- **The fence is a gate, not a given.** The worker's working folder is not a sandbox: a read of `C:\Windows\win.ini` is asked about and was denied by the gate. So the fence is enforced by Friend's approval step, and tools on the allow-list skip the gate, so the allow-list is a security setting.
- **Sessions resume** (`--session-id`, `--resume`): a resumed worker remembered its earlier work. This is how "say something to a worker" and a worker keeping context across tickets are done.
- **Workers run in parallel.** Two at once took 19.5 s wall clock for two tasks that take about 14 s alone.
- **Cost is tiny per small task** (about 0.0015 to 0.0045 notional dollars on the smallest model), but the subscription window is the real limit.
- **The subscription window is visible** in `rate_limit_event`: five-hour and seven-day `utilization` (0 to 1) and `resetsAt`. At the time of the spike the owner's five-hour window was at 96% (resetting 22:40) and the seven-day at 65%. This replaces §3.5's claim that no window figure exists: the HUD's usage ring can show the real window and its reset time, and the Office can pause workers at a configurable utilisation.

## 9. Not hardcoded: everything is a setting of the product

The spike's constants (the model, the command, the folder, the rules in the stand-in server, two workers, the "no installs" rule) are throwaway. In Friend they are all settings, owner-only and PIN-protected like the others, with sensible defaults and no names, paths or roles baked into code:

- `office.enabled`; the program to run (reuses `claudeCode.command`) and the default model (reuses `claudeCode.model`, overridable per role).
- **Roles** are data: id, title, instructions, model, tool allow-list, permission level, working rules. A few starter roles ship as defaults the owner can edit, remove or add to; nothing in the code refers to "coder" or "tester".
- **Projects** are data: name, folder, goal, extra folders a worker may see. The fence is the project folder plus those folders.
- **Approval policy** is data: which tools run without asking (the allow-list), which command patterns are always refused, which always ask, and the PIN tier for each. Approvals go through Friend's own approval engine and tiers, and reach the screen as the HUD's approval instrument, by a new tool on Friend's existing Claude Code bridge, not a separate server.
- **Limits** are data: how many workers run at once (default 2), a per-worker and a total budget, a start-up timeout, and "pause workers when the five-hour window passes N%" (default 90).
- **Strings and colours** come from the theme and the owner's assistant name; no worker or ticket text is fixed in the screen code.
- Every start, stop, approval and denial is audited, and one switch stops everything.