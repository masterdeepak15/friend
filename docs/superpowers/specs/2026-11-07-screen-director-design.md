# Screen director: the assistant drives its own screen

Date: 2026-11-07. Branch: `feat/screen-design`. Status: draft for the owner's review.

## 1. Goal

The assistant should lay out its screen the way a good designer would, on a desktop, a tablet and a phone, so the owner always sees something meaningful: one clear focus, supporting things beside it, small things kept as chips, nothing covering anything, finished things tidied away.

The assistant does this itself. The code gives it (a) a design skill that teaches judgment, (b) intent-based tools so it says what it means instead of giving coordinates, and (c) feedback so it sees and fixes its own result. The server does only geometry and hard safety.

Reference: the owner's Maya demo film (`lemo-opuscar/films/maya-demo`). We learn its rules (one focus, reserved edges, cards that shrink to chips, few things at once, text held long enough). We do not copy its look.

## 2. What exists today (kept, built on)

- `StageObject` with `placement` = five overlapping named regions or a free box; `layer` base/overlay; `ttl`; `pinned`. Tools `stage.show|update|hide|clear|scene|pin|widget|guide|check`.
- `placeObject` (server): after the fact, moves a clashing object to a free region and says so. `stage.check` asks the screen to measure itself (cut off, empty, overlaps, instruments).
- `classifyScreen` (web) reports phone (<=599 px) / tablet (touch or <1024 px) / desktop; the server keeps it (`StageState.setScreen`).
- Orbital HUD: fixed 1600x900 canvas of instruments around an orb, node orbit; under 900 px: chips and stacked instruments. Owner's density (calm/standard/full) and per-instrument switches.
- A 1,500-word layout guide in the prompt (`LAYOUT_GUIDE`) encourages "up to 6 pictures, like a control room", with no limit enforced.
- Bundled plugins folder (`plugins/`) and `skill.use`.

Problems this fixes: regions overlap and know nothing about the instruments; no cap; no "put away" state; the model must think in region names and raw boxes; rules live only in prose; phone/tablet are one sentence each.

## 3. Design

### 3.1 Intent tool: `screen.compose`

One call describes the whole screen. Each item has a **role**:

| role | meaning | where it goes |
|---|---|---|
| `focus` | the thing the owner asked to see | the main zone, biggest |
| `beside` | supports the focus | a side zone |
| `glance` | a small value worth keeping in view (24 C, 3 new) | the chip strip |
| `note` | short passing information | overlay, leaves by itself |
| `alert` | urgent, the owner must act | clears the base screen, shown alone, alert style |

Arguments: `items: [{ id, type, props, role, label? }]`, `mode: "replace" | "add"` (default `replace` for a new topic, `add` for more of the same). The result tells what was placed where and what was changed and why ("the 4th card went to the chips: a tablet shows 2").

The server turns roles into concrete placements from one pure function, `composeScreen(items, state)`, where `state` = screen kind and size, open owner panels, visible HUD instruments (density and switches), pinned widgets, current objects. Output = `StageObject`s with concrete `placement`, plus `docked` ids and notes. No model-chosen coordinates.

`stage.show/update/hide/clear/pin` stay (an explicit region or box still works and is still clamped), but the prompt and skill point to `screen.compose`.

### 3.2 Zones for each screen (one map, `zonesFor`)

Percent of the screen, computed, non-overlapping, minus what the owner and the instruments occupy.

| | desktop (wide) | tablet | phone |
|---|---|---|---|
| focus | wide middle | most of the width | full width, under the orb |
| beside | left and right columns, up to 3 | one side column, up to 2 | none: one card at a time as a bottom sheet |
| chip strip | top, up to 7 | top, up to 5 | scrollable row, up to 5 |
| orb | centre, moves aside when focus is "big" (sandbox page, large chart, table) | smaller | small, at the top |
| HUD instruments | planned around (they are the owner's) | hidden unless asked | hidden unless asked |

Never covered, any size: the captions, status line, clock, the owner's notices, owner panels, pinned widgets. A phone in portrait and in landscape are two entries.

### 3.3 Chips and lifetimes

- Object state `docked`: shown as a chip (label + value, derived from the object: stat value, gauge reading, title). Tap or click brings it back to a zone (the oldest `beside` docks if there is no room).
- Overflow: more `beside` than the zone holds docks the oldest. A new `focus` in `replace` mode docks the previous focus and its sides (nothing is lost; `stage.clear` still removes).
- Time: a `beside` card docks by itself after `screen.dockAfterSeconds` (default 40, 0 = never), but never before its text has been readable: hold >= letters / 15 + 1.5 s. `note` leaves after its ttl (default 15-60 s, as now). `focus` stays until replaced or dismissed. Pinned widgets are the owner's and are never docked by the assistant.
- Configurable, not hardcoded: dock time, chip limit, `screen.autoTidy` (on/off) in settings; safety floors (captions, clock, edges, pinned) are fixed.

### 3.4 Feedback

- `screen.compose` returns the placements and notes, so the assistant knows what happened without another call.
- `stage.check` gains design findings in plain words: more things than the screen's capacity, text too small for the screen, no clear focus, a focus smaller than a third of the stage, a card over an instrument. The assistant fixes what it names and stops (as today, once).
- `describeScreen` (sent with every request) lists the zones and which are free, the chips, and the kind of screen, replacing "free regions".

### 3.5 The skill: `screen-design` (bundled plugin)

Loaded with `skill.use` before drawing a screen it has not drawn before. About 600 words: the principles (answer first; one focus; few things; chips for what is done; hold text; calm after a task; urgent means alone), per-device rules, and worked recipes for the common requests (weather + news, schedule, error, chart + table, compare two things, a long answer, file present, music). `LAYOUT_GUIDE` in the prompt shrinks to the hard rules plus "use screen.compose; read the screen-design skill".

### 3.6 Web

- Render `docked` objects as chips in the strip; tap to restore; keyboard-accessible.
- Use the computed zones (percent boxes) in `Stage`; phone bottom sheet for one card.
- Orb moves aside when the composition marks the focus as big.
- Respect reduced motion; chips rise in with the existing card animation.

## 4. Out of scope

Restyling the HUD or its instruments, new instruments, the owner's drag-and-drop (it stays and wins over the assistant's placement), learning layout preferences over time, any change to chat or office panels.

## 5. Testing

- Pure unit tests of `zonesFor` and `composeScreen` per screen: desktop 1920x1080 and 1366x768, tablet portrait and landscape, phone portrait and landscape: zones never overlap, capacity respected, overflow docks the oldest, the captions/clock/pinned/panels rectangles are never touched.
- Tool tests: `screen.compose` roles, `replace`/`add`, alert alone, idempotent id reuse, unknown role, too many items, unsafe props still refused.
- Dock timing with a fake clock, including the minimum reading time.
- Web tests: chip render, restore by tap, phone sheet, reduced motion.
- Check findings tests.
- Evaluation, not CI: ten typical requests drawn by the assistant on three screen sizes through the real browser (chrome-control), screenshots compared before and after.

## 6. Rulings made in this draft (the owner may change)

- Roles are five (`focus`, `beside`, `glance`, `note`, `alert`): enough to say any common screen; more would bring back coordinates.
- Default dock time 40 s, not the film's 5 s: the film is scripted, a live owner reads at their own pace.
- Explicit placement stays supported: existing flows, tests and the Office keep working.
- Chips come back by tap (not by voice) in this release; "bring back the weather" by voice works through the assistant calling `screen.compose` again.
- The skill ships as a bundled plugin, so it also shows in the Plugins screen and can be switched off.
