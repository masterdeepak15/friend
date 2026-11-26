# Presentations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the owner chose inline execution and asked for a release when done). Steps use checkbox (`- [ ]`) syntax.

**Goal:** The assistant writes a deck, saves it, and a server-side player presents it on the stage (items revealed one by one with animations, each spoken), pausing when the owner speaks and resuming after the answer; decks export to .pptx and standalone HTML.

**Architecture:** A `Deck` schema in `@friend/protocol` (validated with per-layout item capacity). A `DeckStore` (sqlite) and a `Presenter` (state machine over a speaker and a timer) in the server; one new stage command `deck` carries the whole view state to the screens; a web `DeckView` draws it with CSS animations using the existing object renderers. `deck.*` tools are owner-only gateway tools. Export is pure functions (`deckToHtml`, `deckToPptx`).

**Tech Stack:** TypeScript ESM, zod, better-sqlite3 (existing `Db`), React + vitest, `pptxgenjs` (new server dependency, for .pptx only).

**Spec:** `docs/superpowers/specs/2026-11-26-presentations-design.md`

## Global Constraints

- Max 40 slides; max 400 characters per spoken line (`say`); items per slide limited by layout capacity (`bullets` 5, `two-column` 8 (4+4), `visual` 1, `title` 2, `quote` 2, `end` 2).
- Animations: `fade | slide-left | slide-up | grow | type | draw | none`.
- Owner only: `deck.*` tools refuse guests and visitors. `deck.delete` and `deck.export` ask (T2 like `file.write`); the rest need no approval.
- Item content uses existing object types and is checked with `propsError` (`packages/server/src/stage.ts`); pictures only from `file.present` sources; nothing runs on the main page.
- Setting `presentation.resumeSilenceSeconds` (default 20, 0 = never resume alone, range 0–300) is owner-changeable only (assistant refused, like `hud`, `eye`).
- `prefers-reduced-motion`: animations become plain appearance.
- Commit trailers on every commit: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_012ETJR1cqrP2QEgcMSWVVDG`.

## Review Focus

- Owner speaks while the last item of the last slide is being spoken: pause there, resume ends the deck cleanly (no repeat loop).
- Two interrupts in a row (owner talks again before the answer ends): stays paused once, one resume.
- Silence countdown running, owner types: countdown cancelled, no resume while she answers.
- A screen that connects mid-deck draws the current slide with the items already shown, no replayed animation.
- Deleting or editing the deck that is playing: player stops with a sentence, never crashes.
- Voice off or no speaker: plays with captions only, advancing by a reading-time delay.
- An approval card appears mid-presentation: player pauses, resumes after.

---

### Task 1: Deck schema, validation, tool definitions, stage command

**Files:** Create `packages/protocol/src/deck.ts`, `packages/protocol/src/deck.test.ts`; Modify `packages/protocol/src/index.ts` (export), `packages/protocol/src/stage.ts` (add `deck` command), `packages/protocol/src/tools.ts` (defs + `describeCall`).

**Interfaces:**
- Produces: `DECK_LAYOUTS`, `DECK_ANIMATIONS`, `LAYOUT_CAPACITY: Record<DeckLayout, number>`, zod `DeckItem {id, kind, content: Record<string,unknown>, say, animation?, hold?}`, `DeckSlide {id, title, layout, notes?, items}`, `Deck {id, title, topic?, slides, createdAt}`, `deckProblem(deck: unknown): string | null` (sentence or null), `DeckView {deckId, title, index, total, slide: DeckSlide, shown: number, state: "playing"|"paused"|"ended"}`, stage command `{cmd:"deck", view: DeckView | null}`, tool defs `deck.create deck.edit deck.list deck.show deck.present deck.control deck.export deck.delete` (target `gateway`), `DeckControl = next|back|pause|resume|repeat|goto|stop`.

- [ ] **Step 1: Write failing tests** in `deck.test.ts`: `deckProblem` accepts a 3-slide deck; refuses 41 slides ("at most 40 slides"), a `bullets` slide with 6 items (names the slide and says to split it), a `say` of 401 chars, unknown animation, unknown layout, duplicate ids; `StageCommand.safeParse({cmd:"deck", view:null}).success` is true and a view with `shown` > items is false; every `deck.*` TOOL_DEF exists, has `target:"gateway"`, and `deck.delete`/`deck.export` are not T0.
- [ ] **Step 2: Run** `pnpm --filter @friend/protocol vitest run src/deck.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the schemas and `deckProblem` in `deck.ts`; add the stage command and the tool defs (descriptions teach: one idea per slide, ≤5 short items, spoken line adds to the text, animations list, limits); `describeCall` lines for each tool.
- [ ] **Step 4: Run** the protocol suite: `pnpm --filter @friend/protocol vitest run` — Expected: all pass.
- [ ] **Step 5: Commit** `feat(deck): deck schema, limits and tool definitions`.

### Task 2: DeckStore (database)

**Files:** Create `packages/server/src/deck/store.ts`, `packages/server/src/deck/store.test.ts`; Modify the db migration list (find with `search_text "create table if not exists widgets"`).

**Interfaces:**
- Consumes: `Deck`, `deckProblem` (Task 1).
- Produces: `class DeckStore(db: Db)` with `create(input: Omit<Deck,"id"|"createdAt">): Deck | {error: string}`, `get(id): Deck | null`, `list(): {id,title,slides:number,createdAt}[]`, `update(id, fn: (d: Deck) => Deck): Deck | {error: string}` (re-validates), `remove(id): boolean`. Ids are `d_` + 8 hex chars; a damaged row is skipped, not fatal.

- [ ] **Step 1: Failing tests:** create returns an id and persists across a new `DeckStore` on the same db; refuses an invalid deck with the `deckProblem` sentence; update revalidates (adding a 6th bullet refused, deck unchanged); list newest first; remove; damaged JSON row skipped by `list`.
- [ ] **Step 2: Run** `pnpm --filter @friend/server vitest run src/deck/store.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** table `decks(id text primary key, deck_json text, created_at integer)` and the class.
- [ ] **Step 4: Run** the same test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck): deck store`.

### Task 3: Presenter (the player) and the silence setting

**Files:** Create `packages/server/src/deck/presenter.ts`, `packages/server/src/deck/presenter.test.ts`; Modify `packages/server/src/config.ts`, `settings.ts` (add `presentation: { resumeSilenceSeconds }` following the `office` pattern: sanitize, zod schema in `applySettings`, `settingsView`, refused for the agent in `refuseForAgent`), `packages/web/src/settings/settingsApi.ts` (view type + diff), and a small control in `WidgetsTab.tsx` (a number field "Resume by itself after silence (seconds, 0 = wait for continue)").

**Interfaces:**
- Consumes: `Deck`, `DeckView`, `StageCommand`.
- Produces: `interface PresenterDeps { speak(text: string, emit): Promise<void>; interrupt(emit): void; emit(m: ServerMsg): void; now(): number; setTimer(fn: () => void, ms: number): () => void /* returns cancel */; resumeSilenceSeconds(): number; voiceOn(): boolean }`; `class Presenter(deps)` with `start(deck: Deck, from?: {slide:number; item:number}): string`, `control(action: DeckControl, slide?: number): string`, `userSpoke(): void` (pause + cancel silence timer), `answered(): void` (starts the silence countdown when paused), `approvalPending(on: boolean): void`, `deckChanged(id: string, deck: Deck | null): void`, `view(): DeckView | null`, `contextLine(): string | null` ("A presentation of <title> is paused at slide N, item M ('…'). Answer, then use deck.control to continue, repeat, skip or stop.").

- [ ] **Step 1: Failing tests** with fake speak/timer/clock covering: order of items and slides and the emitted `deck` views (`shown` grows 1 per item); `hold` waits; end emits `state:"ended"` then `view:null` after a beat; `userSpoke` mid-speech calls `interrupt`, state `paused`, `contextLine` names slide, item; `control("resume")` repeats the interrupted item then continues; second `userSpoke` while paused is a no-op; `answered()` + silence timer fires `resume` after N seconds, N=0 never fires, a `userSpoke` before it cancels it; paused on the last item then resume ends cleanly; `back`, `goto`, `repeat`, `stop`; `approvalPending(true)` pauses and `(false)` continues only if it was playing before; `deckChanged(id, null)` for the playing deck stops with `control`-style sentence; `voiceOn() === false` advances by reading time (`max(2, words/3)` seconds) without calling `speak`; `start` while playing replaces after `stop`; `start` with unknown `from` is refused with a sentence.
- [ ] **Step 2: Run** `pnpm --filter @friend/server vitest run src/deck/presenter.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `Presenter` as an async step loop guarded by a run id (a paused or stopped run's pending `speak` result is ignored). Settings: `resumeSilenceSeconds` default 20, clamp 0–300.
- [ ] **Step 4: Run** the presenter test and `pnpm --filter @friend/server vitest run src/settings` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck): presenter with pause, resume and resume-after-silence setting`.

### Task 4: Tools, wiring, prompt and guide

**Files:** Modify `packages/server/src/agent/loop.ts` (`deck.*` handler; add `decks?: DeckApi` to `AgentDeps`; add `presenter.contextLine()` to the per-request screen summary), `packages/server/src/app.ts` (construct `DeckStore`, `Presenter` with `speaker`, `broadcast`, config; call `presenter.userSpoke()` on `voice.interrupt`, on typed chat, and at the start of `runVoiceTurn`; call `presenter.answered()` when a turn ends and the presenter is paused; `presenter.approvalPending` from approvals; send the current `deck` view to a connecting screen), `packages/server/src/agent/guide.ts` (topic `presentations`), `packages/server/src/agent/prompt.ts` (one paragraph), `packages/server/src/audit.coverage.test.ts` data if it lists tools. Create `packages/server/src/deck/tools.ts` (`runDeckTool(name,args,deps): ToolResult`) and `tools.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–3. Produces: `runDeckTool(name: string, args: unknown, d: {store: DeckStore; presenter: Presenter; trust: Trust; exportDeck(id: string, format: "pptx"|"html"): Promise<string>}): Promise<ToolResult>`.

- [ ] **Step 1: Failing tests** in `tools.test.ts`: create → list → show returns an outline; a guest is refused for every `deck.*`; `deck.edit` ops `add-slide | replace-slide | move-slide | delete-slide | add-item | replace-item | delete-item`; `deck.present` of an unknown id returns the sentence; `deck.control` without a running deck says so; `deck.create` with 6 bullets returns the split sentence; editing the playing deck calls `presenter.deckChanged`. In `aisettings`-style agent test: a paused presenter's context line reaches the model request.
- [ ] **Step 2: Run** `pnpm --filter @friend/server vitest run src/deck/tools.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the handler, wiring and prompt/guide text (spoken line adds to the slide, does not repeat it; at most five short items; split big topics; ask the owner before a long deck's outline if the topic is vague).
- [ ] **Step 4: Run** full server suite: `pnpm --filter @friend/server vitest run` — Expected: pass (known load-flaky: real-Chrome `browser/hub.test.ts`, python sandbox, Claude Code timing: rerun alone).
- [ ] **Step 5: Commit** `feat(deck): deck tools, presenter wiring, guide`.

### Task 5: The screen (DeckView, animations, controls)

**Files:** Create `packages/web/src/deck/DeckView.tsx`, `deck.css`, `DeckView.test.tsx`; Modify the stage store/reducer that applies `StageCommand` (find with `search_text "case \"widget\""` in `packages/web/src`) to hold `deck: DeckView | null`, `Stage.tsx` and the orbital HUD to mount `DeckView` in the free area when `deck` is set; send `voice.interrupt`-style control messages for the control bar via a new client message `deck.control {action}` handled in `app.ts` (owner only).

**Interfaces:**
- Consumes: `DeckView` (Task 1). Produces: `<DeckView view onControl={(a: DeckControl) => void} />`.

- [ ] **Step 1: Failing tests:** renders title and the first `shown` items only; raising `shown` by one adds one item with class `anim-<name>` and earlier items do not get it again; `state: "paused"` shows a "Paused" label and the play button; buttons call `onControl` with `back|pause|resume|next|stop`; the slide counter reads "3 / 12"; `prefers-reduced-motion` (mock `matchMedia`) renders no `anim-*` class; an item of kind `chart` and a Jarvis `JTable` render through the existing object renderer.
- [ ] **Step 2: Run** `pnpm --filter @friend/web vitest run src/deck` — Expected: FAIL.
- [ ] **Step 3: Implement** the component (CSS keyframes per animation; `type` animates width with steps; `draw` animates stroke-dashoffset via a class the chart renderer honors, falling back to fade).
- [ ] **Step 4: Run** `pnpm --filter @friend/web vitest run` and `pnpm --filter @friend/web tsc --noEmit` — Expected: pass.
- [ ] **Step 5: Commit** `feat(deck): the deck view on the stage`.

### Task 6: Export (.html and .pptx)

**Files:** Create `packages/server/src/deck/exportHtml.ts`, `exportPptx.ts`, `export.test.ts`; Modify `packages/server/package.json` (`pnpm --filter @friend/server add pptxgenjs`); wire `exportDeck` in `app.ts` to write into the owner's files area (find the approved-files directory with `search_text "file.present"`), returning the download path.

**Interfaces:**
- Produces: `deckToHtml(deck: Deck): string` (standalone page, inline CSS and JS, items revealed with arrow keys or click, `say` lines as captions, no `http` addresses in the output); `deckToPptx(deck: Deck): Promise<Buffer>` (title, bullets, tables native, charts and other objects as a text summary line, `say` + `notes` in slide notes, entrance effect only for `fade`).

- [ ] **Step 1: Failing tests:** html contains every item text and caption, contains no `http://`/`https://`, escapes `<script>` in text, includes `prefers-reduced-motion`; pptx buffer is a zip, re-read with the existing `pptxText` (`packages/server/src/attach/extract.ts`) returns the titles and bullets in order and the notes contain the spoken lines.
- [ ] **Step 2: Run** `pnpm --filter @friend/server vitest run src/deck/export.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** both functions.
- [ ] **Step 4: Run** the test — Expected: PASS.
- [ ] **Step 5: Commit** `feat(deck): export a deck as html and pptx`.

### Task 7: Docs, full verification, release 0.1.95

**Files:** Modify `README.md` (a "Presentations" section and the settings row), `packages/friend/package.json` (0.1.95).

- [ ] **Step 1:** Add the README section (what to say, the controls, interruption and silence behavior, export, limits).
- [ ] **Step 2: Run** `pnpm -r tsc --noEmit` and `pnpm -r vitest run` — Expected: pass apart from the known load-flaky tests, each re-run alone and passing.
- [ ] **Step 3: Run the app** (skill `run`): present a 3-slide test deck in a browser, interrupt, answer, resume, and let a silence resume; screenshot the slide in classic and orbital layouts. Fix what looks wrong.
- [ ] **Step 4: Commit** docs; bump version to 0.1.95, commit `chore: release 0.1.95`; `pnpm package`; `cd packages/friend && npm publish`; `git push origin main`.
