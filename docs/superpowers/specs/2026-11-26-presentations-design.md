# Presentations: the assistant makes a deck and presents it live

Status: awaiting owner approval. Size: a project. PC agents stay on hold.

## Why

The owner wants to say "make a presentation on hacking", get the deck, then have the assistant present it on the screen like a person in a meeting or a teacher in class: slide after slide, items appearing one by one with an animation, each item explained out loud. The owner can talk during it: the assistant stops, answers, then carries on. A deck can also be exported to a file.

## Today (found in the code)

- The stage draws objects (cards, charts, tables, timelines, graphs, `sandbox` pages for custom animation, about forty Jarvis components). There is no deck, no slide order, no "current slide".
- `Speaker.speak(text)` says a text sentence by sentence and `Speaker.interrupt()` stops it on every screen. Voice input already exists.
- The assistant can read a `.pptx` (text only). Nothing writes one. The server has no zip or pptx writer dependency; a real Chrome is available through the safe browser.
- Owner-pinned widgets and settings-driven instruments must not be disturbed by a presentation.

## Goals

- **Deck**: the assistant writes a whole deck in one go, saves it, and can show it later, edit it, or delete it.
- **Player**: runs the deck from the start (or a given slide): per item it reveals the item with its animation, speaks its line, then moves on. No model call while a slide plays.
- **Talk during it (decided with the owner)**: when the owner speaks, speech stops at once, the player pauses on that item, the assistant answers as in any conversation, and then the player resumes (see Interrupting).
- **Reveal one by one**: inside a slide, items (bullets, a chart, a picture, a table) appear in order, each with an animation, as in PowerPoint's build-in.
- **Controls** by voice or buttons: next, back, pause, resume, go to slide N, stop, speed.
- **Export** (see Export): a .pptx to edit in PowerPoint and a standalone HTML file that plays on its own with the same animations.

## Non-goals

- Not a full slide editor in the browser. The owner edits by telling the assistant ("change slide 3", "add a slide on phishing"), or in PowerPoint after exporting.
- No recording to video in this project.
- No live co-presenting with other screens beyond what the stage already does (every connected screen shows the same slide).

## Anti-goals

- A presentation that talks over the owner or will not stop when told.
- A deck that covers or moves the owner's pinned widgets, or hides what the owner has to approve (an approval card always comes on top and pauses the player).
- A deck that draws code from the assistant on the main page: custom animation stays inside the isolated `sandbox` frame like today.
- Exporting a file the owner did not ask for, or writing outside the files area the owner approved.

## Approaches (chosen with the owner: A)

- **A. Write the deck first, then a server-side player runs it. Chosen.** Cheap and fast to play (no model call per slide), replayable, interruptible at a known place, and the same deck exports to files.
- B. The assistant presents live, one slide per turn. Rejected: slow and costly, her pace drifts, and an interruption leaves her to remember where she was.
- C. Only make a .pptx or HTML and open it. Rejected as the main design: nothing speaks along and nothing reveals live. Kept as the export.

## The deck

A deck is saved in the database (owner-private, like the pinned widgets):

```
Deck  { id, title, topic, createdAt, slides: Slide[] }          // at most 40 slides
Slide { id, title, layout, notes?, items: Item[] }              // at most 8 items
Item  { id, kind, content, say, animation?, hold? }
```

- `layout`: `title`, `bullets`, `visual` (one big object), `two-column`, `quote`, `end`. The player picks places itself, using the screen director so nothing lands on an instrument, a panel or a pinned widget.
- `kind` and `content` reuse the existing object types: `text` (a heading or a bullet), `list`, `card`, `stat`, `chart`, `table`, `graph`, `timeline`, `code`, image from `file.present`, any Jarvis component, or `sandbox` (an animated page). Each is checked by the same rules as a stage object today (`propsError`), so nothing new can be drawn.
- `say`: what the assistant says while this item appears. Written to be spoken (short sentences, no symbols read out). The slide's `notes` are for the owner and for export, not spoken.
- `animation`: one of `fade`, `slide-left`, `slide-up`, `grow`, `type` (text typed out), `draw` (a chart or graph draws in), `none`. Default by kind. Items with `hold` wait that many seconds after speaking (default: none).
- Order of items is the order they appear and are spoken.

## The player (server)

One `Presenter` per Friend, holding: the deck, a cursor (slide, item), a state (`idle`, `playing`, `paused`), and the speech job it started.

Step of the loop:
1. Tell the screens to show item N (a `deck` stage command: slide, item, animation).
2. `Speaker.speak(item.say)`; wait until it ends (or is interrupted).
3. Honour `hold`; advance the cursor; at the end of a slide's items, wait a short beat, move to the next slide (a transition command), and continue. The end of the deck says a closing line and goes `idle`.

Rules:
- The screens render a slide from the cursor they are told, so a screen that connects mid-way gets the current slide and the items already shown (no animation replay for those).
- Only one presentation runs at a time. Starting another asks which wins.
- The player pauses for a pending approval and continues afterwards.
- A presentation never runs for a guest or a visitor; only the owner starts and controls one (like the owner-only tools today).

## Interrupting (decided with the owner: pause, answer, resume)

- When the owner starts speaking (voice activity while playing), the player calls `Speaker.interrupt()` and goes `paused` on the current item. The item that was being spoken is remembered with how far it got.
- The owner's words go to the assistant as an ordinary turn, with one added line in its context: "A presentation of <title> is paused at slide 3, item 2 ('…'). Answer, then use `deck.control` to continue, repeat, skip or stop." So she can answer a question, explain more, or change the deck.
- She resumes with `deck.control {action: "resume"}`. By default resume repeats the interrupted item from its start, then goes on. The owner can also say "continue", "go on", "skip this" or "go back".
- If the owner does not say anything for a while after an answer, she asks once: "Shall I continue?" It does not resume by itself without her asking (a setting could change that later; not in this project).
- Typed messages also pause the player the same way. The owner's own controls on the screen (a small bar: back, play or pause, next, stop, slide count) work at any time.

## Tools for the assistant

All are owner-only. Creating and presenting need no approval (they draw on the screen like `screen.compose`); exporting writes a file and asks like `file.write` does.

- `deck.create {title, topic, slides[]}`: validates and saves; returns the deck id and a short outline. For a long deck she creates the outline first and adds slides with `deck.edit` (decks of many slides do not fit one answer).
- `deck.edit {id, op, ...}`: add, replace, move or delete a slide or an item.
- `deck.list`, `deck.show {id}` (text outline for her, not drawn).
- `deck.present {id, from?: {slide, item}, speed?}`: starts the player.
- `deck.control {action: next | back | pause | resume | repeat | goto | stop, slide?}`.
- `deck.export {id, format: pptx | html}`: see Export.
- `deck.delete {id}`: asks first.
- `stage.guide` gets a "presentations" topic: how to write good slides (one idea per slide, at most five short items, the spoken line adds to the text and does not repeat it), the animations, and the limits.

## The screen (web)

- A `Deck` stage view: a full-stage slide area with the title and the revealed items. It uses the existing object renderers for item content, so Jarvis components, charts and sandbox pages all work inside slides.
- Animations are CSS transitions chosen by the item's `animation`. `prefers-reduced-motion` turns them into plain appearance.
- A small control bar and a slide counter at the edge of the stage. The orbital HUD and the classic screen both keep their instruments, chat and approval cards; the slide uses the free area the screen director reports.
- The assistant's face or presence stays visible and shows "speaking" as usual.

## Export (decided: both formats; PDF later)

- **.pptx**: one slide per slide, the title as a title, text items as bullets, charts, tables and lists as native PowerPoint tables or as pictures when no native form fits, speaker script in the slide's notes, and the animation as PowerPoint's entrance effect where one matches (fade, wipe in, appear), otherwise none. Opens and edits in PowerPoint, Keynote and Google Slides. Built with a small, well-known writer library added as a server dependency (decided at planning; a hand-made zip only if the library is too heavy).
- **HTML**: one standalone file with its own styles, scripts and pictures inline. It plays by itself in any browser with the same reveals and animations, arrow keys and click to move, and the `say` lines shown as captions (no speaking, no network). Sandbox pages stay in their isolated frames.
- The file goes to the owner's files area and is offered as a download link, never written elsewhere. The assistant says where it is.
- **PDF** is not in this project: the safe browser could print the HTML to PDF later with little work.
- Importing an existing .pptx into a deck is not in this project.

## Limits and safety

- At most 40 slides, 8 items a slide, 400 characters a spoken line, and the same size limits as stage objects. A deck larger than that is refused with the sentence saying which limit.
- Nothing in a deck can run on the main page; text is data. Pictures come only from files the owner approved with `file.present`.
- Speaking uses the owner's voice settings and `voice.enabled`; with voice off the deck plays with captions only.
- Every `deck.*` call is audited with the deck id and slide count.

## Testing (what the plan must cover)

- Deck validation: limits, kinds, animations, rejects what `propsError` rejects.
- Player with a fake speaker and clock: order, holds, end of deck, pause at interrupt and resume repeats the item, resume from the middle, approval pause, one presentation at a time, owner only.
- A screen connecting mid-presentation gets the current state.
- Web: reveal order, animations off with reduced motion, controls, no overlap with the instruments, the orbital and classic layouts.
- Export: a .pptx that re-reads with the existing pptx reader (titles, bullets, notes in order); the HTML file contains every item, plays through with keys, and contains no network address.
- The assistant's prompt and tool descriptions, and the screens' audit coverage test (every tool is classified).

## What is left to the builder

- Exact JSON field names and the stage command shape for the `Deck` view.
- The writer library for .pptx, and which items become pictures.
- How the assistant gets the "paused at …" line into a turn.
- Whether the control bar is a stage object or a HUD part per layout.

## Open questions for the owner

1. Is "pause, answer, resume by asking" right, or should it resume by itself after her answer when the owner says nothing for a few seconds?
2. Is 40 slides and 8 items a slide enough?
