# Friend Orbital HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `orbital` screen layout to Friend: a clear centre with the orb and a segmented usage ring, an orbit of hex nodes, and edge widgets that each have their own shape and animation, every widget clickable to expand. The current screen stays as the `classic` layout.

**Architecture:** A new setting `hud.layout` (`classic` | `orbital`) plus `hud.density` and per-widget switches flow through the existing config → settings → `ui` message → web store path. When the layout is `orbital`, `Stage` keeps the existing `Presence` orb and objects and mounts a new `OrbitalHud` layer on top; `classic` renders exactly as today. The HUD is inline SVG + CSS (no new dependency). Pure modules hold the geometry and the widget/density rules; presentational components form an animation kit; widgets read the store or two small feeds (usage summary, a new 2-second server stats message).

**Tech Stack:** TypeScript, React 18, zod (protocol), vitest + @testing-library/react + jsdom (web), vitest (server, protocol). Package names: `@friend/protocol`, `@friend/server`, `@friend/web`.

**Spec:** `docs/superpowers/specs/2026-10-20-friend-hud-and-office-design.md` (§3). The Office (§5) is a later plan.

## Global Constraints

- Free only; no new npm dependency, no paid service. (spec §1, §3.6)
- Configurable, not hardcoded: layout, density and each widget are settings; thresholds and intervals are named constants in one place. (spec §3.4)
- `classic` is unchanged and its existing tests keep passing. (spec §3.7)
- No change to authentication, trust tiers, approvals or the voice pipeline. (spec §3.7)
- Orange means "needs the owner" only; cyan is the base; green is running. Colours derive from the existing mood accent. (spec §3.2)
- Every animation stops when `hud.animations` is `off` or the OS asks for reduced motion; `reduced` keeps only gentle loops. (spec §3.4)
- All HUD loops pause when the tab is hidden; no animation causes per-frame React renders. (spec §3.6)
- Widgets are isolated with the stage's `Safe` boundary pattern. (spec §3.7)
- Settings changes stay owner-only through the existing `hud` rule in `settings.ts` (the assistant cannot change `hud`). (settings.ts:352)
- Test commands: `pnpm --filter @friend/web exec vitest run <path>`, same for `@friend/server` and `@friend/protocol`; type check with `pnpm --filter <pkg> typecheck` (`pnpm --filter @friend/server exec tsc --noEmit` if the script is missing).
- Commit trailers on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_012ETJR1cqrP2QEgcMSWVVDG`.
- Shell on this machine is Windows PowerShell 5.1; files are UTF-8 without BOM.

## Review Focus

1. **Classic regression:** with `layout: "classic"` (and with no `hud.layout` at all, e.g. an old saved config) the screen must render exactly as before. Pinned in Task 7.
2. **Tiny and odd windows:** 1366×768, a very wide window, a portrait tablet and a 360px phone must never overlap the orb or hide the command bar; the phone gets no orbit. Pinned in Tasks 3 and 11.
3. **Reduced motion and `animations: off`:** no loop runs, values still update. Pinned in Task 5.
4. **A widget that throws or has no data** (stats feed silent, usage endpoint failing, zero launcher items) shows a quiet empty state, never a broken screen. Pinned in Tasks 7–9.
5. **Click-away:** expanding a widget must not trap focus, must close on Esc and outside click, and must not swallow the long-press-to-talk gesture on the stage. Pinned in Task 10.

---

### Task 1: Settings contract (protocol and server)

**Files:**
- Modify: `packages/protocol/src/hud.ts` (add constants), `packages/protocol/src/messages.ts` (extend `HudView`, add `hud.stats` server message)
- Modify: `packages/server/src/config.ts` (`HudConfig`, `sanitizeHud`), `packages/server/src/settings.ts` (zod `hud` object at ~line 125, apply at ~486, snapshot at ~305), `packages/server/src/app.ts` (`uiMsg` at ~line 683)
- Test: `packages/protocol/src/protocol.test.ts`, `packages/server/src/config.test.ts`, `packages/server/src/settings.test.ts` (add cases to the existing files)

**Interfaces:**
- Produces (protocol): `HUD_LAYOUTS = ["classic","orbital"] as const`, `HUD_DENSITIES = ["calm","standard","full"] as const`, `HUD_WIDGET_IDS = ["system","voice","network","feed","radar","tickets","budget","approval","usage"] as const`, types `HudLayout`, `HudDensity`, `HudWidgetId`.
- `HudView` and `HudConfig` gain `layout: HudLayout` (default `"classic"`), `density: HudDensity` (default `"standard"`), `widgets: Partial<Record<HudWidgetId, boolean>>` (default `{}`; only known ids kept, values coerced to booleans).
- Produces (protocol): server message `{ type: "hud.stats", cpu: number /*0..100*/, ramUsed: number /*bytes*/, ramTotal: number, netDown: number /*bytes per second*/, netUp: number }`.

- [ ] **Step 1: Write failing tests**
  - protocol: `HudView` parses a view with `layout:"orbital"`, `density:"calm"`, `widgets:{radar:false}`; rejects `layout:"cube"`; `ServerMsg` parses a valid `hud.stats` and rejects `cpu: 101`.
  - config: `sanitizeHud({})` → `layout:"classic"`, `density:"standard"`, `widgets:{}`; `sanitizeHud({layout:"orbital",density:"full",widgets:{radar:false,bogus:true,feed:"yes"}})` → `layout:"orbital"`, `density:"full"`, `widgets:{radar:false}` (unknown id dropped, non-boolean dropped); `sanitizeHud({layout:"nope"})` → `"classic"`.
  - settings: applying `{hud:{layout:"orbital"}}` changes `config.hud.layout`; `{hud:{widgets:{radar:false}}}` merges into (does not replace) existing `widgets`; `{hud:{layout:"cube"}}` is rejected by the schema; the existing rule still blocks the assistant (non-owner path) from changing `hud`.
- [ ] **Step 2: Run them and watch them fail** (`pnpm --filter @friend/protocol exec vitest run src/protocol.test.ts`, then server config and settings tests). Expected: FAIL on missing fields.
- [ ] **Step 3: Implement** the constants, schema fields, `sanitizeHud`, settings merge (treat `widgets` like `clock`: `Object.assign` into the existing object), snapshot copy (`widgets: {...c.hud.widgets}`), and add the three fields to `uiMsg` in `app.ts`.
- [ ] **Step 4: Run protocol and server suites and both type checks.** Expected: PASS, no type errors (fix every place that builds a `HudView` or `HudConfig` literal, e.g. test fixtures).
- [ ] **Step 5: Commit** `feat(hud): orbital layout, density and widget switches in the settings contract`.

---

### Task 2: Store and Settings screen controls (web)

**Files:**
- Modify: `packages/web/src/settings/settingsApi.ts` (`HudSettings` type gains the three fields), `packages/web/src/settings/WidgetsTab.tsx` (new "Screen layout" section), `packages/web/src/store.ts` (apply `hud.stats`; `stats: HudStats | null` in state)
- Test: `packages/web/src/settings/widgets.hud.test.tsx` (new), `packages/web/src/hud/stats.store.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 constants and message.
- Produces: `StageViewState.stats: { cpu: number; ramUsed: number; ramTotal: number; netDown: number; netUp: number; at: number } | null`; `reduce` handles `hud.stats`. `WidgetsTab` calls the existing `onHud({layout})`, `onHud({density})`, `onHud({widgets:{[id]:boolean}})`.

- [ ] **Step 1: Failing tests.** WidgetsTab shows a "Screen layout" select with Classic/Orbital, a "Density" select with Calm/Standard/Full and one checkbox per `HUD_WIDGET_IDS` entry (checked unless explicitly `false`); changing each calls `onHud` with exactly the matching partial (`{widgets:{radar:false}}` for one box); the checkboxes are disabled while layout is Classic. Store test: `reduce(initialState, {type:"hud.stats",...})` sets `stats` with a number `at`; malformed input leaves state unchanged.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** the section (plain words, with a one-line help under each control, matching the tab's existing style) and the reducer case.
- [ ] **Step 4: Run web suite for settings and store files, then `pnpm --filter @friend/web typecheck`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): layout, density and widget switches on the settings screen`.

---

### Task 3: Orbital geometry (pure)

**Files:**
- Create: `packages/web/src/hud/orbital/geometry.ts`
- Test: `packages/web/src/hud/orbital/geometry.test.ts`

**Interfaces:**
- Produces:
  - `orbitRadius(w: number, h: number): number` = `0.33 × min(w,h)`, never below 120.
  - `orbitNodes(count: number, w: number, h: number): { x: number; y: number; angle: number }[]` — centre `(w/2,h/2)`, first node at the top (angle −90°), evenly spaced, `count` clamped 0..12.
  - `type ZoneId = "top"|"left-top"|"left-mid"|"left-bottom"|"right-top"|"right-mid"|"right-bottom"|"bottom"`.
  - `zoneRect(zone: ZoneId, w: number, h: number): { x: number; y: number; width: number; height: number }`.
  - `layoutMode(w: number, h: number): "orbit" | "compact"` — `compact` when `w < 900` (phone and narrow tablet).
  - `centreClear(w: number, h: number): { cx: number; cy: number; r: number }` — the circle the orbit rings occupy.

- [ ] **Step 1: Failing tests (exact assertions).** `orbitNodes(4,1920,1080)[0]` is `{x:960,y:540−orbitRadius,angle:−90}`; four nodes are 90° apart; `orbitNodes(0,…)` is `[]`; `orbitNodes(20,…)` has length 12. For viewports 1920×1080, 1366×768, 2560×1080 (ultrawide) and 1080×1920 (portrait): no `zoneRect` overlaps `centreClear`'s bounding box, and every zone stays inside the viewport. `layoutMode(599,900)` and `layoutMode(899,600)` are `"compact"`, `layoutMode(900,600)` is `"orbit"`.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.** Zones are fractions of the viewport (named constants at the top: side rails 19% and 21% wide, top bar 6% tall, bottom bar 7% tall); the orbit radius shrinks, never the rails, when the aspect ratio is extreme.
- [ ] **Step 4: Run geometry tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hud): orbital geometry`.

---

### Task 4: Widget registry and density rules (pure)

**Files:**
- Create: `packages/web/src/hud/orbital/registry.ts`
- Test: `packages/web/src/hud/orbital/registry.test.ts`

**Interfaces:**
- Consumes: `ZoneId` (Task 3); `HudDensity`, `HudWidgetId` (Task 1).
- Produces:
  - `interface WidgetDef { id: HudWidgetId; title: string; zone: ZoneId | "centre"; tone: "cyan"|"green"|"orange"; minDensity: HudDensity }`.
  - `WIDGETS: readonly WidgetDef[]` — one entry per `HUD_WIDGET_IDS`, placed as in the approved mockup (`orbital-v2.html`): system -> `left-top`, voice -> `left-mid`, network -> `left-mid` (below voice), feed -> `left-bottom`, radar -> `right-top`, tickets -> `right-mid`, budget -> `right-mid` (below tickets), approval -> `right-bottom`, usage -> `"centre"` (the segmented ring around the orb).
  - `visibleWidgets(density: HudDensity, widgets: Partial<Record<HudWidgetId, boolean>>, mode: "orbit"|"compact", approvalPending: boolean): WidgetDef[]`.

Rules: `calm` shows none of the edge widgets (orb, orbit, usage ring, command bar only) except `approval` when one is pending; `standard` shows `system, voice, feed, approval, usage`; `full` shows all. A widget set to `false` is hidden at every density; `true` forces it on at `calm`/`standard` too. `approval` is shown whenever `approvalPending`, whatever the switches say (an approval must never be hideable). In `compact` mode the result lists the same widgets (the compact view stacks them) but `usage` stays.

- [ ] **Step 1: Failing tests** for each rule above, including: approval pending at `calm` with `widgets:{approval:false}` still shows it; ids not in `HUD_WIDGET_IDS` cannot appear; order is stable (registry order).
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hud): widget registry and density rules`.

---

### Task 5: Animation kit (shapes and CSS)

**Files:**
- Create: `packages/web/src/hud/orbital/kit.tsx`, `packages/web/src/hud/orbital/orbital.css`
- Test: `packages/web/src/hud/orbital/kit.test.tsx`

**Interfaces:**
- Produces (all presentational, SVG/HTML, take `tone?: "cyan"|"green"|"orange"` defaulting to cyan, and an `aria-label` or `aria-hidden` as appropriate):
  - `<Frame variant="chamfer"|"bracket"|"octagon"|"slant" width height title? running?>` — border shape with an optional running light.
  - `<ArcGauge value inner? label>` (semicircle, `value` 0..100, optional inner arc), `<Spectrum levels: number[]>`, `<PulseLine>` (running-light waveform), `<Radar blips: {angle,distance,label,tone}[]>`, `<HexCells cells: {status:"done"|"doing"|"review"|"todo"}[]>`, `<Rings rings: {value,tone}[]>` (concentric), `<SegmentedRing value segments=60 radius>` (the usage ring), `<HexNode label status="running"|"waiting"|"idle"|"add">`, `<LinkLine from to tone flowing>`.
  - `orbital.css` defines the keyframes (spin, flow, run, pulse, eq, ecg, ping, breathe, blink) under a root class `.orbital`, gated: `[data-hud-anim="off"] .orbital *{animation:none}`, `[data-hud-anim="reduced"]` keeps only `pulse` and `breathe`, and `@media (prefers-reduced-motion: reduce)` behaves as `off`; `@media` not needed for hidden tabs because `document.hidden` is handled in Task 7 by a `data-paused` attribute that sets `animation-play-state: paused`.

- [ ] **Step 1: Failing tests.** Each component renders without throwing for empty, normal and extreme props (`value` −5 and 500 are clamped to 0 and 100; empty `levels`/`blips`/`cells` render an empty shape); `SegmentedRing value=42 segments=60` marks exactly 25 segments as filled (`Math.round(60×0.42)`); `HexNode status="waiting"` carries tone orange; every interactive component (`HexNode`) is a `button` with an accessible name; decorative shapes are `aria-hidden`. A CSS test reads `orbital.css` and asserts the `off` and `reduced` gates exist and that `prefers-reduced-motion` is present.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** using one shared `<svg><defs>` glow filter component (`<HudDefs/>`) mounted once by Task 7, referenced by id.
- [ ] **Step 4: Run kit tests and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hud): animation kit and shapes`.

---

### Task 6: Server stats feed

**Files:**
- Create: `packages/server/src/hudStats.ts`
- Modify: `packages/server/src/app.ts` (start an interval at startup, clear it in the existing stop path; broadcast only when `config.hud.layout === "orbital"`)
- Test: `packages/server/src/hudStats.test.ts`

**Interfaces:**
- Produces: `class StatsSampler { constructor(opts?: { cpus?: () => os.CpuInfo[]; totalmem?: () => number; freemem?: () => number; net?: () => { rx: number; tx: number } | null; now?: () => number }); sample(): { cpu: number; ramUsed: number; ramTotal: number; netDown: number; netUp: number } }` — CPU % from the delta of cumulative idle/total between calls (first call returns 0), RAM from `os`, network bytes per second from the delta of the counters (0 when the counter source is unavailable). `const HUD_STATS_INTERVAL_MS = 2000`.
- Network counters: on Windows there is no cheap built-in; use `null` (netDown/netUp 0) unless the platform exposes them; the widget (Task 9) then shows "n/a". Do not add a dependency or spawn a shell per tick.

- [ ] **Step 1: Failing tests** with injected fakes: first sample cpu 0; second sample after idle drops from 90% to 40% idle gives the expected busy %; RAM numbers pass through; `net: () => null` yields zeros; counters going backwards (restart) give 0, not negative.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** the sampler and the interval; `app.ts` broadcasts `{type:"hud.stats",...}` each tick only in orbital layout (read `config.hud.layout` each tick so a settings change takes effect without restart) and clears the timer on stop.
- [ ] **Step 4: Run server suite for the new file and the app tests; typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): a stats feed for the orbital HUD`.

---

### Task 7: OrbitalHud scene and wiring

**Files:**
- Create: `packages/web/src/hud/orbital/OrbitalHud.tsx`
- Modify: `packages/web/src/stage/Stage.tsx` (mount `OrbitalHud` when `state.hud?.layout === "orbital"`), `packages/web/src/App.tsx` (pass the launcher, usage and handlers; keep `classic` path identical), `packages/web/src/styles.css` or `orbital.css` import
- Test: `packages/web/src/hud/orbital/orbital.view.test.tsx`, extend `packages/web/src/app.view.test.tsx`

**Interfaces:**
- Consumes: Tasks 3, 4, 5.
- Produces: `<OrbitalHud hud={HudView} state={StageViewState} launcher={HudView["launcher"]} onLaunch={(item)=>void} onExpand={(id: ExpandId)=>void} />` where `type ExpandId = { kind: "widget"; id: HudWidgetId } | { kind: "node"; id: string }`. Draws: `HudDefs`, the centre rings and `SegmentedRing` around the orb (the orb itself stays `Presence`), the orbit ring, one `HexNode` per launcher item with a `LinkLine` to the orb, the top bar (name, link state, clock reuse), and the visible widgets' frames (contents in Tasks 8–9; here each shows its title only). Sets `data-paused` on its root while `document.hidden`. Uses `window` size via the stage's viewport hook.
- Mount rules: in `compact` mode renders the chip row instead of the orbit. The orb, command bar, objects, captions, overlay and long-press-to-talk are untouched.

- [ ] **Step 1: Failing tests.** With `layout:"orbital"`: `OrbitalHud` renders N nodes for N launcher items and none for an empty launcher (no crash); at `calm` density no edge frames render; with `layout:"classic"` and with `hud` null the stage DOM has no `.orbital` element and the existing stage tests still pass unchanged (run the full web suite for this check); a pending approval at `calm` shows the approval frame; hiding the document sets `data-paused`.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** and wire. `onLaunch` reuses the existing `launch` handler in `App.tsx` for launcher items.
- [ ] **Step 4: Run the whole web suite and typecheck.** Expected: PASS (911+ tests, no regressions).
- [ ] **Step 5: Commit** `feat(web): the orbital HUD scene`.

---

### Task 8: Widgets on existing data

**Files:**
- Create: `packages/web/src/hud/orbital/widgets/` with `VoiceWidget.tsx`, `FeedWidget.tsx`, `ApprovalWidget.tsx`, `UsageRing.tsx`, `TicketsWidget.tsx`, `BudgetWidget.tsx`, and `useUsage.ts`
- Modify: `OrbitalHud.tsx` to render them in their frames
- Test: `packages/web/src/hud/orbital/widgets/widgets.test.tsx`, `useUsage.test.ts`

**Interfaces:**
- `useUsage(fetcher = httpUsageApi): { today: number; peak: number; share: number | null; error: boolean }` — calls `summary(30)` once on mount and every 5 minutes, `share = today / peak` clamped 0..1 (null when no data or peak 0). **Ruling:** the Claude subscription exposes no usage-window percentage, so the ring shows today's tokens relative to the owner's busiest day of the last 30 days, and its caption says so ("today vs your busiest day").
- `VoiceWidget({ level: number, mode: VoiceMode })` — `Spectrum` driven by `state.voice.level` (16 smoothed bars), label from the mode.
- `FeedWidget({ lines: ChatLine[], activity: string|null, busy: boolean })` — the last ~8 lines of activity/chat as a scrolling terminal; empty state "Nothing yet".
- `ApprovalWidget({ approval: PendingApproval, send })` — octagon, orange, shows the tool and summary, APPROVE/DENY buttons that send the same messages the existing `ApprovalCard` sends (reuse its handlers; the existing card still renders when the HUD is classic).
- `TicketsWidget` and `BudgetWidget` show an honest empty state ("No workers yet") until the Office exists.

- [ ] **Step 1: Failing tests.** `useUsage` with a fake fetcher: share 0.42 for today 42/peak 100; null when peak 0; sets `error` and keeps rendering when the fetch rejects; refetch every 5 min (fake timers) and stop on unmount. Widgets: spectrum shows 16 bars and flattens at level 0; feed shows the newest line and the empty state; approval buttons send the exact existing approve/deny messages and the widget is a labelled `alertdialog`-like region reachable by keyboard; usage ring caption says "today vs your busiest day" and renders at `share:null` as an empty ring with "no data yet".
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.** In orbital layout the old `ApprovalCard` must not also render (single source of truth): `Overlay` receives a flag `hudApproval` that hides the card; classic keeps it.
- [ ] **Step 4: Run web suite and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hud): voice, feed, approval, usage, tickets and budget widgets`.

---

### Task 9: Widgets on the stats feed and devices

**Files:**
- Create: `packages/web/src/hud/orbital/widgets/SystemWidget.tsx`, `NetworkWidget.tsx`, `RadarWidget.tsx`
- Modify: `OrbitalHud.tsx`
- Test: `packages/web/src/hud/orbital/widgets/stats.widgets.test.tsx`

**Interfaces:**
- `SystemWidget({ stats })` — `ArcGauge` (CPU) with inner arc (RAM share); `stats: null` shows "waiting for data"; stats older than 10 s (`now - at`) show "stale".
- `NetworkWidget({ stats })` — `PulseLine` with `↓ x/s ↑ y/s` formatted (B, KB, MB); zeros show "n/a" when the server reports no counters.
- `RadarWidget({ deviceOnline, voiceAvailable })` — blips only for real data: "This screen" (always), "PC" (`deviceOnline`), "Voice" (`voiceAvailable`); an offline source shows a dim blip, never an invented one. **Ruling:** Friend only knows these, not a full device list; more blips come with the Office/devices work.

- [ ] **Step 1: Failing tests** for the formats (`1536` → `1.5 KB`, `5_242_880` → `5.0 MB`), null and stale states, and radar blips matching the inputs exactly (offline PC → dim, not absent).
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hud): system, network and radar widgets`.

---

### Task 10: Click to expand, keyboard and Esc

**Files:**
- Create: `packages/web/src/hud/orbital/ExpandedView.tsx`
- Modify: `OrbitalHud.tsx`, `App.tsx` (the `onExpand` handler), existing Esc handling in the overlay/menu so the HUD close runs first
- Test: `packages/web/src/hud/orbital/expand.test.tsx`

**Interfaces:**
- `<ExpandedView target={ExpandId} onClose={()=>void} ...>` renders in the centre area as a framed panel: for a `widget` target the widget at large size (usage → the per-source usage list from the existing `UsageTab` data; feed → the full chat log via the existing `ChatPanel`; system/network/voice/radar/tickets/budget → the same widget enlarged with a short plain-words explanation); for a `node` target it performs the launcher action (`onLaunch`) and does not open a panel (panel actions open the existing panel).
- Behaviour: one expanded item at a time; Esc, a click outside, or the close mark closes it; focus moves into the view on open and returns to the opener on close; Enter/Space on a focused widget or node opens it; Tab order follows zones.

- [ ] **Step 1: Failing tests.** Click on a widget opens `ExpandedView` with that widget; second click on another widget replaces it; Esc closes and focus returns to the opener; outside click closes; Enter on a focused node opens/launches it; a short tap on the empty stage still opens the command bar and a long press still talks (the stage handlers keep working while no view is expanded, and while one is expanded a press outside closes it without starting a recording).
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement.** The HUD layer uses `pointer-events: none` on its root and `auto` only on widgets and nodes, so the stage's long press keeps working everywhere else.
- [ ] **Step 4: Run web suite and typecheck.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(hud): click to expand, keyboard and Esc`.

---

### Task 11: Compact layout, motion settings, docs and a real-browser check

**Files:**
- Modify: `OrbitalHud.tsx` (compact chip row and swipeable widget strip), `packages/web/src/hud/orbital/orbital.css`, `README.md` (settings table: `hud.layout`, `hud.density`, `hud.widgets`; a short "Orbital screen" section), `packages/agent-cli` docs only if its docs test lists settings (keep the docs test passing)
- Test: `packages/web/src/hud/orbital/compact.test.tsx`

- [ ] **Step 1: Failing tests.** At width 360 no orbit ring and no `HexNode` ring layout render; the launcher items render as a horizontal chip row; the orb, command bar and approval widget are present; with `data-hud-anim="off"` the root carries the attribute the CSS gates on; at width 1920 the orbit renders.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement**, update the README, run the full suites (`protocol`, `server`, `web`, and the agent-cli docs test). Expected: all pass except the known unrelated `brokers/hub.test.ts` "remembers the login after a restart" failure, which must be reported by name.
- [ ] **Step 4: Verify in a real browser** (Chrome via the chrome-control tools): start Friend, set `hud.layout` to `orbital` in Settings, open the screen at 1920×1080, 1366×768 and a phone-width window, take screenshots, compare to the approved mockup (`.superpowers/brainstorm/…/orbital-v2.html`) for structure, click a node and a widget, press Esc, switch density to Calm and back, set animations to Off and confirm the motion stops, switch back to Classic and confirm the old screen. Record any defect and fix it with a test first.
- [ ] **Step 5: Commit** `feat(web): compact orbital layout, motion gates and docs`.

---

## Self-review notes
- Spec coverage: §3.1 layout → Tasks 3, 7; §3.2 widgets → 4, 5, 8, 9; §3.3 interaction → 10; §3.4 settings → 1, 2, 11; §3.5 feeds → 6, 8, 9; §3.6 rendering and performance → 5, 7, 11; §3.7 safety → 7, 8 (single approval source); §3.8 testing → every task. Spec §3.1 says the usage ring is "1/60 of the Claude usage window"; the plan's ruling (Task 8) replaces that with today's usage relative to the busiest day, because the window percentage is not available. The spec is amended to match.
- Type consistency: `HudWidgetId`, `HudDensity`, `HudLayout` (Task 1) are the only sources of those names in Tasks 2–10; `ZoneId` (Task 3) is the only zone type; `ExpandId` (Task 7) is the only expand target type.
- The Office (spec §5) has no task here by design; its plan is written after this ships.
