# Screen Director Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The assistant drives its own screen through intent tools (`screen.compose`), a bundled design skill and design feedback; the server only turns intent into positions for desktop, tablet and phone and keeps the safety floors.

**Architecture:** Pure geometry in `@friend/protocol` (`zones.ts`: zones per screen, chip text, instrument rectangles). A pure `composeScreen` in the server turns roles into placements, docks and notes. `StageObject` gains `role`, `docked`, `label`; a new `dock` stage command moves an object to the chip strip and back. The web `Stage` renders a chip strip and restores on tap. A bundled `screen-design` plugin holds the skill; `LAYOUT_GUIDE` shrinks to the hard rules.

**Tech Stack:** TypeScript ESM pnpm monorepo, zod, Fastify, React/vite, vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-screen-director-design.md`

## Global Constraints

- Safety floors fixed, never settings: the captions, status line, clock, owner notices, owner panels, pinned widgets and the screen edge are never covered or moved by the assistant (`SAFE` in `protocol/src/layout.ts` stays).
- Knobs are settings, not constants: `screen.dockAfterSeconds` (default 40, 0 = never), `screen.maxChips` (default by screen: desktop 7, tablet 5, phone 5; settable 1-12), `screen.autoTidy` (default true).
- Minimum reading time before an automatic dock: `letters / 15 + 1.5` s (English), where letters = total characters of the object's text props.
- Capacities: desktop `beside` 3, tablet 2, phone 0 (one card at a time, stacked under the focus); chips as above.
- Roles are exactly `focus | beside | glance | note | alert`. Explicit `placement` in `stage.show` stays supported and clamped; the owner's drag (`place` from the screen) wins over compose.
- Cross-platform (Windows, Mac, Linux); free-only services; never type the owner's PIN; no release, merge or publish without the owner's explicit instruction.
- Existing suites stay green (the stage, layout, overlay, orbital and approval tests). Commit with the trailer lines the session gives.

## Review Focus

- The screen changes kind while objects are shown (phone turned, window resized, another device): re-resolve the shown objects for the new screen; nothing is lost (extras dock).
- Same `id` composed twice (idempotent: updated, not duplicated) and a `focus` replaced in `add` mode.
- An object the owner dragged (`place` from the owner) is not moved by a later compose.
- A pinned widget is never docked, hidden or moved, even by `mode: "replace"` or `alert`.
- More items than zones plus the 12-object limit (`MAX_OBJECTS`): the extras dock, then the call fails cleanly with a plain sentence, never half-applied.
- `alert` while a `focus` is shown: base screen cleared (pinned stay), the alert alone, then the previous focus is not silently lost (it docks as a chip).
- A tiny screen (phone landscape 667x375): zones still non-overlapping and above the captions.

## File Structure

- Create `packages/protocol/src/zones.ts` (+ `zones.test.ts`): `zonesFor`, `isBig`, `chipOf`, `INSTRUMENT_RECTS`, `readSeconds`.
- Modify `packages/protocol/src/stage.ts`: `ObjectRole`, `StageObject` fields, `dock` command. Modify `index.ts` exports.
- Modify `packages/protocol/src/tools.ts`: `screen.compose` def, `stage.check` description. Modify `messages.ts`: ClientMsg `stage.dock`.
- Create `packages/server/src/agent/compose.ts` (+ `compose.test.ts`): `composeScreen`.
- Modify `packages/server/src/stage.ts`: `StageState` (`dock`, `tidy`, `relayout`, `trackInstruments`, owner-placed set), `runStageTool` (compose branch, design findings).
- Modify `packages/server/src/agent/layout.ts` (`describeScreen`, shrink `LAYOUT_GUIDE`), `agent/guide.ts` (layout topic), `agent/loop.ts` (route the tool), `config.ts` (`ScreenConfig`), `app.ts` (wiring, `stage.dock` message, tidy timer).
- Modify web: `store.ts` (`dock` reducer), `stage/Stage.tsx` + new `stage/ChipStrip.tsx` (+ tests), `styles.css`, `settings/WidgetsTab.tsx` (three knobs).
- Create `plugins/screen-design/plugin.json` and `plugins/screen-design/skills/screen-design.md`.
- Docs: `docs/guides/screen-director.md`, README line.

---

### Task 1: Roles, docked state and the dock command

**Files:**
- Modify: `packages/protocol/src/stage.ts`, `packages/protocol/src/index.ts`
- Modify: `packages/web/src/store.ts` (`applyStage`)
- Test: `packages/protocol/src/stage.dock.test.ts`, `packages/web/src/stage/dock.reduce.test.ts`

**Interfaces:**
- Produces: `ObjectRole = "focus"|"beside"|"glance"|"note"|"alert"`; `StageObject.role?`, `StageObject.docked?: boolean`, `StageObject.label?: string (max 40)`; `StageCommand` `{cmd:"dock", id:string, docked:boolean}`.

- [ ] **Step 1: Write failing tests.** `stage.dock.test.ts`: `StageObject` accepts `role:"focus"`, `docked:true`, `label:"24 C"`; rejects `role:"hero"` and a 41-character label; `StageCommand` accepts `{cmd:"dock",id:"w",docked:true}` and rejects a missing `id`. `dock.reduce.test.ts`: `reduce` of a `stage` message `dock` sets `docked` on that object only, a second `dock` with `docked:false` clears it, an unknown id changes nothing.
- [ ] **Step 2: Run** `pnpm -F @friend/protocol test stage.dock` and `pnpm -F @friend/web test dock.reduce`. Expected: FAIL (fields and command missing).
- [ ] **Step 3: Implement** the zod additions in `stage.ts`, export `ObjectRole`, and the `dock` case in `applyStage` (`docked: cmd.docked || undefined` so false removes the key).
- [ ] **Step 4: Run** both again plus `pnpm -F @friend/protocol test` and `pnpm -F @friend/web test store`. Expected: PASS, no other failure.
- [ ] **Step 5: Commit** `feat(stage): roles, docked state and a dock command`.

### Task 2: Zones, chip text and instrument rectangles (pure)

**Files:**
- Create: `packages/protocol/src/zones.ts`, `packages/protocol/src/zones.test.ts`
- Modify: `packages/protocol/src/index.ts`; `packages/web/src/hud/orbital/registry.test.ts` (consistency test)

**Interfaces:**
- Consumes: `Rect`, `SAFE`, `overlap`, `clampToSafe` (`layout.ts`); `ScreenInfo`; `HudWidgetId`; `StageObject`.
- Produces:
  - `INSTRUMENT_RECTS: Record<HudWidgetId, Rect>` (percent of the screen: each `WIDGETS` box of `registry.ts` divided by 1600 x 900).
  - `interface Taken { panels: Rect[]; instruments: Rect[] }`.
  - `interface Zones { focus: Rect; focusBig: Rect; beside: Rect[]; chipMax: number; stack: boolean }` (`stack` true on a phone: placement is `auto`, one card under the focus).
  - `zonesFor(screen: ScreenInfo | null, taken?: Taken, maxChips?: number): Zones`.
  - `isBig(type: string, props: Record<string, unknown>): boolean` (sandbox, pdf, video, gallery, table with more than 6 rows, chart; the Jarvis natural size from `jarvisNaturalSize` above 40% of the screen width).
  - `chipOf(o: StageObject): { label: string; value?: string }` (`stat`: label + value + unit; `gauge`: label + value%; `countdown`/`progress`: label + the shown value; otherwise `o.label ?? props.title ?? id`, 24 characters).
  - `readSeconds(o: StageObject): number` = `chars / 15 + 1.5` over text props (`text`, `title`, `items`, `rows`, `markdown` flattened).

- [ ] **Step 1: Write failing tests** (`zones.test.ts`): for each of desktop 1920x1080, desktop 1366x768, tablet 1024x768 and 768x1024 (touch), phone 390x844 and 667x375: `focus` and every `beside` rect lie inside `SAFE`, no two zone rects overlap more than 0.01, capacity is 3/3/2/2/0/0 (beside), `stack` true only on the phones. With `taken.instruments` on the right side, no `beside` slot overlaps it (>0.25) and capacity drops accordingly; with both sides taken, `beside` is empty and `focus` is not narrower than 40% of the width. `chipOf` cases above, a 60-character title cut to 24. `isBig` true for a sandbox, false for a stat. `readSeconds` of a 150-character card is 11.5. Registry consistency (`registry.test.ts`): every `INSTRUMENT_RECTS[id]` equals its `WIDGETS` box over 1600x900 within 0.01.
- [ ] **Step 2: Run** `pnpm -F @friend/protocol test zones` and `pnpm -F @friend/web test registry`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `zones.ts`. Desktop base: focus `[26,12,48,56]`, `focusBig [14,10,72,64]`, slots in fill order right-top `[75,12,22,30]`, left-top `[3,12,22,30]`, right-lower `[75,44,22,30]`; tablet: focus `[4,12,64,58]`, slots `[70,12,26,30]`, `[70,44,26,30]`; phone: focus `[2,10,96,40]`, `beside: []`, `stack: true`. A slot is dropped when it overlaps a `taken` rect by more than 0.25 (`overlap`); `focus` is then widened to the free width but never above `focusBig`'s width. `chipMax` defaults desktop 7, tablet 5, phone 5, overridable by `maxChips` (1-12).
- [ ] **Step 4: Run** the two commands again. Expected: PASS.
- [ ] **Step 5: Commit** `feat(layout): zones for every screen size, chip text, instrument rectangles`.

### Task 3: composeScreen (pure intent to placement)

**Files:**
- Create: `packages/server/src/agent/compose.ts`, `packages/server/src/agent/compose.test.ts`

**Interfaces:**
- Consumes: `zonesFor`, `isBig`, `chipOf`, `readSeconds`, `PANEL_RECTS` (`agent/layout.ts`), `StageObject`, `ObjectRole`, `ScreenInfo`.
- Produces:
  - `interface ComposeItem { id: string; type: string; props: Record<string, unknown>; role: ObjectRole; label?: string; ttl?: number }`
  - `interface ComposeState { screen: ScreenInfo | null; panels: PanelName[]; instruments: HudWidgetId[]; current: StageObject[]; ownerPlaced: ReadonlySet<string>; maxChips?: number }`
  - `interface ComposeResult { show: StageObject[]; hide: string[]; dock: string[]; undock: string[]; clear: boolean; scene: SceneMode; notes: string[] }`
  - `composeScreen(items: ComposeItem[], mode: "replace" | "add", state: ComposeState): ComposeResult`

- [ ] **Step 1: Write failing tests** (`compose.test.ts`), each a named case:
  - `focus alone goes to the focus zone, scene focus when big, conversation otherwise`.
  - `one focus and two beside on desktop fill right-top then left-top`; `a third beside beyond capacity docks the oldest current beside and says so`.
  - `glance becomes a docked chip with a label`; `chips beyond chipMax dock the oldest glance out as a note in notes`.
  - `note is an overlay with a ttl between 15 and 60`.
  - `alert in replace mode clears the base screen, shows alone with style alert, docks the previous focus`.
  - `replace mode docks previous focus and beside objects; add mode keeps them`.
  - `pinned widgets are never in hide, dock or clear lists`; `ownerPlaced ids keep their placement`.
  - `same id twice updates in place (one show, not two)`.
  - `phone: focus first then one beside as stacked auto, the rest docked`; `phone landscape 667x375 keeps every box in SAFE`.
  - `more items than MAX 12 objects: the extras dock; if still over, throws a plain Error`.
  - `unknown role or empty items throws a plain Error`.
  - `instruments on the right take the right slots away`.
- [ ] **Step 2: Run** `pnpm -F @friend/server test agent/compose`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `composeScreen` as a pure function. Order of work: validate; build the target set (replace: current non-pinned objects not re-listed go to `dock` if their role was `focus|beside`, otherwise `hide`; add: keep); assign `focus` the zone (`focusBig` when `isBig`), `beside` the slots in order (oldest dock out when full); `glance` and overflow produce `docked: true` objects; `note` gets `layer: "overlay"`, `placement: "center"`, ttl clamped 15-60; `alert` implies `clear: true`, `style: "alert"`, scene `focus`. Every returned placement is a box `{x,y,w,h}` in 0-1 units, or `"auto"` when `stack`.
- [ ] **Step 4: Run** the test file, then the whole `pnpm -F @friend/server test agent/layout agent/compose`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stage): composeScreen turns roles into placements, docks and notes`.

### Task 4: `screen.compose` tool, StageState docking, relayout, restore

**Files:**
- Modify: `packages/protocol/src/tools.ts` (def), `packages/protocol/src/messages.ts` (ClientMsg `stage.dock`), `packages/server/src/stage.ts`, `packages/server/src/agent/loop.ts`, `packages/server/src/app.ts`
- Test: `packages/server/src/stage.compose.test.ts`, `packages/protocol/src/screen.compose.test.ts`, `packages/server/src/stage.relayout.test.ts`; update `audit.coverage.test.ts` if it enumerates tools or client messages.

**Interfaces:**
- Consumes: `composeScreen`, `ComposeResult`, Task 1 command.
- Produces:
  - Tool `screen.compose`, input `{ items: ComposeItem[] (1-8), mode?: "replace"|"add" }`, `baseTier: "T0"`, `target: "gateway"`.
  - `StageState.trackInstruments(read: () => HudWidgetId[]): void`; `StageState.dock(id: string, docked: boolean, now?: number): ApplyResult`; `StageState.relayout(): StageCommand[]` (re-runs `composeScreen` with the objects' stored roles after a screen change; returns the `show`/`dock` commands to emit); `StageState.markOwnerPlaced(id)` (set when `apply(place, now, byOwner=true)`).
  - `runStageTool("screen.compose", args, stage, emit)` returns `ok. Placed: <id> -> <zone>; ... Docked: ...; <notes>`.
  - ClientMsg `{type:"stage.dock", objectId:string, docked:boolean}` handled in `app.ts` next to `stage.pin`; restoring docks the oldest `beside` if the zone is full.

- [ ] **Step 1: Write failing tests.** `screen.compose.test.ts`: the def exists, rejects 9 items and an unknown role. `stage.compose.test.ts`: via `runStageTool` on a real `StageState` with `setScreen(desktop)`: compose focus + beside → two `stage` show messages with boxes inside `SAFE`; second compose in replace mode emits `dock` for the first focus and keeps a pinned widget; failure at the 12-object limit returns `ok:false` and leaves the state unchanged (snapshot equal before and after); alert clears and shows alone; `stage.dock` message path: restoring a chip docks the oldest beside when full. `stage.relayout.test.ts`: desktop compose of focus + 3 beside, `setScreen(phone)`, `relayout()` returns commands leaving focus + 1 stacked, two docked, none lost; back to desktop restores slots for docked beside objects that were docked only by capacity.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the def (description tells roles, modes and that placement is computed). In `runStageTool`, branch on `screen.compose` before the generic path; gather `ComposeState` from the `StageState` (`screenInfo`, `openPanels`, instruments source, snapshot objects, owner-placed set); apply the result atomically: clone the state, apply each command, only then commit and emit (on error return the sentence and emit nothing). In `loop.ts` route `screen.compose` to `runStageTool` (find the `stage.` routing with `search_text "stage."` first). In `app.ts`: `trackInstruments` from `config.hud.widgets` (true) plus `stage.snapshot().widgets` plus calm-density `usage`; call `relayout()` and emit its commands where the `ui.screen` message sets the screen; handle `stage.dock`.
- [ ] **Step 4: Run** the three files plus `pnpm -F @friend/server test stage agent/layout`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stage): screen.compose, docking, relayout when the screen changes`.

### Task 5: Settings and automatic tidy

**Files:**
- Modify: `packages/server/src/config.ts` (`ScreenConfig`, `sanitizeScreen`), `packages/server/src/stage.ts` (`tidy`), `packages/server/src/app.ts` (timer beside the existing `stage.expire` call, settings route and `uiMsg` as `hud` does), `packages/web/src/settings/WidgetsTab.tsx`
- Test: `packages/server/src/screen.settings.test.ts`, `packages/server/src/stage.tidy.test.ts`, `packages/web/src/settings/screenKnobs.test.tsx`

**Interfaces:**
- Produces: `interface ScreenConfig { dockAfterSeconds: number; maxChips: number | null; autoTidy: boolean }` (defaults 40, null = by screen, true); `sanitizeScreen(raw: unknown): ScreenConfig` (clamps `dockAfterSeconds` 0-3600, `maxChips` 1-12 or null); `StageState.tidy(now: number, cfg: ScreenConfig): StageCommand[]` returning `dock` commands.

- [ ] **Step 1: Write failing tests.** `screen.settings.test.ts`: defaults; garbage input falls back; clamps. `stage.tidy.test.ts` (fake clock): a `beside` object docks only after `max(dockAfterSeconds, readSeconds)`; with `dockAfterSeconds: 0` or `autoTidy: false` nothing docks; `focus`, `note`, pinned and owner-placed objects are never docked by `tidy`; an object updated by `stage.update` restarts its timer. `screenKnobs.test.tsx`: the three controls render with current values and send the changed value.
- [ ] **Step 2: Run** the three files. Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror how `sanitizeHud`, the config update route and the `uiMsg` carry `hud` (read those first); store a `shownAt` per object in `StageState` (set on show, reset on update); the app's existing expiry timer also calls `tidy` and emits its commands; settings tab gets a short "Screen tidy" group.
- [ ] **Step 4: Run** the files plus `pnpm -F @friend/server test config hudlayout` and `pnpm -F @friend/web test settings`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(screen): tidy settings and automatic docking after the reading time`.

### Task 6: Web chip strip and restore

**Files:**
- Create: `packages/web/src/stage/ChipStrip.tsx`
- Modify: `packages/web/src/stage/Stage.tsx` (docked objects are not rendered as cards; render the strip), `packages/web/src/styles.css`
- Test: `packages/web/src/stage/chips.test.tsx`

**Interfaces:**
- Consumes: `chipOf`, docked objects from `state.objects`.
- Produces: `<ChipStrip chips={StageObject[]} onRestore={(id: string) => void} />` (a `nav` landmark labelled "Put away"; each chip a `button` with `aria-label="Show <label>"`).

- [ ] **Step 1: Write failing tests** (`chips.test.tsx`): docked objects render as chips with label and value and no card; clicking a chip sends `{type:"stage.dock", objectId, docked:false}`; Enter and Space on a focused chip do the same; the strip is absent with no docked objects; on a phone width (390) the strip is a horizontally scrollable row; chips never overlap the captions (strip is in the top zone, `top` within `SAFE`); reduced motion renders no animation class; a docked object that throws in `chipOf` does not break the stage (`Safe`).
- [ ] **Step 2: Run** `pnpm -F @friend/web test chips`. Expected: FAIL.
- [ ] **Step 3: Implement** `ChipStrip`, filter `docked` out of `autos`/`fixed`/`overlays` in `Stage.tsx`, mount the strip inside `.objects`, add styles (glass pill, accent value, rise-in 0.45 s, `prefers-reduced-motion` off). On a phone the strip sits under the orb above the stacked cards.
- [ ] **Step 4: Run** `pnpm -F @friend/web test stage` (all stage tests). Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): put-away chips with tap to bring back`.

### Task 7: Feedback: design findings and screen description

**Files:**
- Modify: `packages/server/src/stage.ts` (findings appended to `stage.check` output), `packages/server/src/agent/layout.ts` (`describeScreen`)
- Test: `packages/server/src/stage.findings.test.ts`, update `agent/layout.test.ts`

**Interfaces:**
- Produces: `designFindings(objects: StageObject[], screen: ScreenInfo | null): string[]`: sentences for `more cards than <n> fit on a <kind>`, `there is no focus: nothing is the main thing`, `the focus is smaller than a third of the stage`, `<n> things are on screen for a <kind>; put some away`. `describeScreen` lists the zones free (`focus`, `beside 1/3 free`), the chips (`chips: <labels>`), and replaces `free regions`.

- [ ] **Step 1: Write failing tests:** each finding appears for its condition and not otherwise; a clean desktop composition returns none; `describeScreen` output contains `zones:` and `chips:` and no longer contains `free regions` on a wide screen; a phone still omits regions.
- [ ] **Step 2: Run** `pnpm -F @friend/server test stage.findings agent/layout`. Expected: FAIL.
- [ ] **Step 3: Implement.** Findings run server-side from the stage state and are appended after the screen's own measured lines (text-size is not measured: ruling, see Rulings). Update the existing layout tests that asserted `free regions`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(stage): design findings in stage.check, zones and chips in the screen description`.

### Task 8: The skill and the shorter guide

**Files:**
- Create: `plugins/screen-design/plugin.json`, `plugins/screen-design/skills/screen-design.md`
- Modify: `packages/server/src/agent/layout.ts` (`LAYOUT_GUIDE`), `packages/server/src/agent/guide.ts` (layout topic), `packages/server/src/agent/prompt.ts` only if the guide is referenced there
- Test: `packages/server/src/agent/screenDesign.skill.test.ts`, update `agent/layout.test.ts`, `agent/guide.test.ts`

**Interfaces:**
- Produces: plugin id `screen-design`, skill `screen-design` (under 20 KB, in plain words): principles (answer first, one focus, few things, put away what is done, hold text, urgent alone), per-device rules (desktop, tablet, phone portrait/landscape), recipes (weather + news, schedule, error, chart + table, compare two, long answer, file present, music) each as a `screen.compose` example.

- [ ] **Step 1: Write failing tests:** the bundled folder loads through the existing plugin loader with one skill named `screen-design`; the skill text mentions each role and `screen.compose`; `LAYOUT_GUIDE` contains `screen.compose` and `screen-design` and no longer contains `up to 6 pictures` or `like a control room`; the guide's layout topic mentions roles; the prompt stays within its existing size test if there is one.
- [ ] **Step 2: Run** `pnpm -F @friend/server test screenDesign agent/layout agent/guide`. Expected: FAIL.
- [ ] **Step 3: Write** the skill (about 600 words) and rewrite `LAYOUT_GUIDE` to: the fixed parts of the screen (kept), the five roles with one line each, "use `screen.compose`; load the `screen-design` skill before a screen you have not drawn", lifetimes, pinned, theme colours (kept verbatim), overlay/alert rules. Remove the "control room / up to 6" paragraph and the region-name instructions (regions remain valid for `stage.show`, mentioned in one line).
- [ ] **Step 4: Run** the same command plus `pnpm -F @friend/server test plugins`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plugins): screen-design skill; the layout guide points to screen.compose`.

### Task 9: Whole-suite check, evaluation in a real browser, docs

**Files:**
- Create: `docs/guides/screen-director.md`; modify `README.md` (one paragraph)
- Create (not committed): evaluation screenshots in the scratchpad

- [ ] **Step 1: Run** `pnpm -r test` and `pnpm -r build`. Expected: green except the known load-flaky real-process tests (connectors, python sandbox, claude session, chrome plugin route, Office view), which are rerun alone.
- [ ] **Step 2: Evaluate with the real browser.** Start the app, and with chrome-control draw these ten requests through the assistant at 1920x1080, 1366x768, 1024x768 (touch) and 390x844: weather + news; today's schedule; a long error; a chart + a table; compare two numbers; a long explanation; a file; music; a deliberate overflow (five things at once); turn the phone mid-screen. Save screenshots; check by eye that nothing overlaps, the focus is clear, extras are chips, captions and clock are free. Note failures; fix once (skill text or zones), then re-check.
- [ ] **Step 3: Write** `docs/guides/screen-director.md` (what the assistant now does, the roles, the three settings, how chips work, how the owner's drag wins) and the README paragraph.
- [ ] **Step 4: Run** `pnpm -r test` once more. Expected: same as Step 1.
- [ ] **Step 5: Commit** `docs(screen): guide for the screen director`.

## Rulings made while writing this plan

- Design findings are computed on the server from the stage state (count, focus, size); text size is not measured because the screen's own check does not report it today. Cost if wrong: one finding the spec listed is missing; it can be added to the screen's measurement later.
- Instruments the assistant plans around are those the owner switched on, those the assistant brought up, and the calm-density usage line; instrument rectangles are copied into the protocol from the registry and a test keeps them equal.
- `relayout` runs when the screen kind or size class changes, not on every pixel of resize (the existing 400 ms report debounce is reused).
- Owner-dragged objects keep their place; the assistant must `stage.hide` and show again to move them.
