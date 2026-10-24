# Friend memory tree and heartbeat

Date: 2026-10-24. Status: draft for the owner's review. Nothing here is built yet.

## Intent

The owner wants an assistant that is independent and loyal, like a person who knows them: it remembers across months, notices what matters, and
speaks first when it has something worth saying. Today the talk is one way: Friend answers when asked.

Two parts, in this order, because a pulse without memory only produces pings with no personality:

1. **A memory tree**: small plain-text notes in a tree with one entry point, read on demand, so memory can grow for years without growing the
   cost of every turn.
2. **A heartbeat that can start a conversation**: Friend wakes on a slow rhythm and on events, and decides to stay quiet, speak, or message.

Ideas come from the owner's Spyder skills (`assistant`, `agent-memory`): one `INDEX.md`, topic indexes, one small file per item, load only what
the turn needs, an end-of-turn "did anything worth keeping happen" check, and a proactive tone. Nothing is copied. Spyder runs as a prompt for
Claude Code and depends on the model obeying "hard gate" text (the skill itself records that it often did not) and is about 19 KB per load.
Friend is a server, so the rules that must always hold are enforced in code, and the prompt only carries a small index.

## What exists now

- `memory.remember`, `memory.search`, `memory.forget` over a flat SQLite table: at most 200 notes of 500 characters, each shown in the prompt
  as "Notes about the owner" (data, never instructions). The owner can list and delete every one.
- A `Heartbeat` (every 15 s) that only notifies due reminders. It never starts a model turn.
- Telegram, WhatsApp and SMS as plugins, the voice and screen channels, and the Office feeding "a worker finished" events to Friend.

## Part 1: the memory tree

### Where it lives

A folder of Markdown files in Friend's data folder, `<data>/memory/`, which is already a protected path: workers and guests cannot reach it
and no approval mode skips the question for it. The owner can open, edit and back it up with any editor. SQLite keeps only what must be fast
(a search index) and can be rebuilt from the files.

### Shape

```
memory/
  INDEX.md              the entry point, about 300 tokens, always in the prompt
  about-owner/          INDEX.md + one small note per fact group (health, habits, language, routine)
  people/               INDEX.md + one note per person (family, friends, colleagues)
  projects/             INDEX.md + one note per project (status, next step, where its files are)
  trading/              INDEX.md + notes (limits the owner set, watchlist, lessons from past trades)
  preferences/          INDEX.md + notes (tone, how the owner likes things done, corrections)
  days/                 one note per day: what happened, mood, what is open
  inbox/                short unsorted notes, tidied into the right branch later
```

- Branch names are not fixed by the program. The index and the folders are whatever the assistant and the owner build; the five above are
  where a new tree starts.
- Every folder has an `INDEX.md` that is a table of links: one line per note (title, one-sentence summary, last updated). Detail lives only in
  the note. A note is short: aim for under 150 words; one that grows is split.
- Notes carry a small header: `updated`, `source` (owner said it, assistant inferred it, a tool showed it) and optional `expires`.
- The root `INDEX.md` has: who the owner is in three lines, the branch list with one line each, and "open loops" (what is waiting on whom).

### What Friend reads

Each turn the prompt gets the root `INDEX.md` only, plus any notes the server pre-selects for this turn by keyword and recency (the owner's
words matched to note titles and summaries; a cap of a few notes). The model can follow a branch with `memory.read(path)`. A turn that needs no
memory costs the index and nothing more. A budget in tokens caps what is loaded in total, and the cap is a setting.

### What Friend writes

Tools: `memory.read(path)`, `memory.write(path, text)`, `memory.append(path, text)`, `memory.move(from, to)`, `memory.forget(path)`,
`memory.search(query)` (the existing name stays and now searches the files). A write also updates the folder's `INDEX.md` line in the same
call, so an index can never be out of date.

A step in code, not in the prompt, decides when to save:

- After a turn in which the owner said something about themselves, made a decision, corrected Friend, or a task or worker finished, the server
  runs a short, separate "what is worth keeping" pass with the turn's text. It returns a few small writes. A turn of small talk or a pure
  question writes nothing. A closing "thanks" is judged on the whole conversation, which is the failure Spyder describes.
- The pass writes in the owner's style of short notes, merges into an existing note before it makes a new one, and puts doubtful items in
  `inbox/`. It never stores secrets (passwords, PINs, keys, card numbers) and never stores the text of a web page or a worker's report as a fact:
  what it saw is stored as "seen on <date> in <source>", not as true.
- Once a day (idle time, "like sleep"), a consolidation pass folds `days/` notes into the longer-term notes, merges duplicates, marks stale
  facts, and proposes forgetting expired ones. It writes a one-paragraph "what changed" note the owner can read.

The pass can run on the owner's subscription model or, if the owner chooses, a small local model (a setting), so memory upkeep does not use
the main model's limit.

### Safety

- Everything in memory is data about the owner, never instructions (as the current notes block already says). A note cannot grant permission,
  change a setting or start work.
- Memory is shown only to the owner. Guests and household members never get it; the existing "never reveal private details" rule stays.
- The owner can see what Friend remembers: a Memory screen (tree view, open a note, edit, delete, "forget everything about X") and a line in
  the reply when something is saved ("saved: <title>") that can be switched off.
- Friend cannot raise its own autonomy from memory: memory text is not read as settings.
- Existing 200 flat notes are imported once into `inbox/` and then sorted by the first consolidation pass; the old table is kept until the
  owner confirms.

### Settings (nothing hardcoded)

`memory.enabled`, `memory.autoSave` (off / ask first / on), `memory.maxLoadTokens`, `memory.dailyConsolidation`, `memory.model`
(main / local), `memory.showSavedLine`. Changing `autoSave` and `model` is owner-only, on the settings screen, like the Office level.

## Part 2: the heartbeat that can speak first

### Rhythm

Two sources of wake-ups, both free to check:

- **Slow beat**: every N minutes (default 45; setting). A code-only check asks: has anything changed since the last beat? (a due or overdue
  task, a worker finished or stuck, a calendar item soon, a market event on something the owner watches or holds, the owner silent for longer
  than usual, the first time on screen today, a memory item with a date today). If nothing changed, nothing runs and no tokens are spent.
- **Events**: the same list, pushed (a worker finishes, a reminder falls due, a result lands). These already exist as signals.

### Deciding

Only when the check finds something, one short model turn gets: the time, the change, a few lines of memory from the relevant branch, and
the owner's current state (on screen, last seen, quiet hours). It must answer with one of: `stay quiet`, `say it on screen/voice`, `send it to
the phone`, or `leave a note for the next time they appear`. Its words go through the normal turn, so tone and persona stay consistent.

### Limits and control (owner settings)

- Level: **off**, **low** (only things the owner asked for: reminders, workers, calendar), **medium** (useful nudges and a morning and evening
  check-in), **high** (a companion that checks in on patterns, like a few quiet days or a long silence).
- Quiet hours (no voice or phone messages), a daily cap on contacts, a minimum gap between contacts, a channel order (screen, voice, phone),
  and "do not disturb" in one switch.
- It never acts on its own in this part: a heartbeat turn may speak and may save a memory, and may not run tools that change anything (no
  files, no orders, no messages to other people, no worker work) unless the owner's level for that is already allowed. The wake-up turn is
  limited to read-only tools.
- Every wake-up and every decision is written to the audit log, and a stay-quiet answer is cheap and visible ("last woke 14:10: nothing").

### Cost

The slow beat is code only. A model turn happens only when the check found something, and is capped by the daily contact cap. The owner can
choose the local model for these turns.

## Rollout, in steps that are each worth shipping on their own

1. **Memory tree, read side**: folder and files, root index in the prompt, `memory.read` and `memory.search` over files, import of the old notes,
   Memory screen (view, edit, delete). Acceptance: a turn that needs no memory costs no more prompt than today with 200 notes; a note edited
   by hand is what Friend reads next turn.
2. **Memory tree, write side**: the save pass after turns, `memory.write/append/move/forget`, index kept in step, secret filter, "saved" line,
   `autoSave` setting. Acceptance: tests with a script of turns show saves for facts and corrections and none for small talk; a closing
   "thanks" after real work saves; secrets are never written.
3. **Consolidation**: the daily pass, duplicate merge, expiry, the "what changed" note.
4. **Heartbeat**: the change check, the decision turn, the levels, quiet hours and caps, audit, the settings tab. Start with `low` only (reminders,
   workers, calendar) and add `medium` and `high` behaviour afterwards.

Each step has its own tests (file-system fixtures for the tree, scripted turns for the save pass, a fake clock for the heartbeat) and is
released only when the owner says so.

## Not in this design

Voice that interrupts (barge-in), a model that runs all day, sending anything to other people on its own, and any order-placing. Each would need
its own design and approval.

## Questions for the owner

1. Is `<data>/memory/` right, or should the folder be somewhere the owner syncs (for example a cloud folder)?
2. `autoSave` default: ask first, or save and show a "saved" line? (Recommendation: save and show the line; the owner can delete.)
3. Should upkeep use the main model or a local one? (Recommendation: main model at first; local if limits become a problem.)
4. Which levels of the heartbeat does the owner want first? (Recommendation: low, then medium.)
5. Which phone channel for messages: Telegram, WhatsApp, or SMS?
