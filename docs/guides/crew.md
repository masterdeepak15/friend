# The crew

The crew is a second kind of worker. **Office workers** are Claude Code sessions that work in your project folders (see the Office). **Crew workers** run on Friend's own engine, with the model you already set up, so they need no Claude Code. You can have both; they do not touch each other.

Ask your assistant: "hire Ada as a researcher, she may use the web" or "hire Ben to take notes in meetings".

## What a worker is

- **Its own conversation.** What you ask a worker and what it answers is kept apart from your talk with the assistant and from every other worker. A worker knows nothing of your other conversations, so the assistant tells it everything it needs in the task.
- **Its own memory.** Each worker has a wiki of notes like the assistant's, but its own: markdown notes in `<data folder>/crew/<worker>/memory/` (the assistant's is `<data folder>/memory/`), and its conversation is in `<data folder>/crew/<worker>/friend.db`. The assistant's notes and the other workers' notes are never mixed in. A worker looks after its memory the way the assistant does: the index of its wiki is in its prompt, what is worth keeping is saved after its work, unfiled notes are tidied into topic folders, and a long conversation is compacted by the same session settings (Settings, Memory and Session). Removing a worker deletes its folder, unless you say to keep it (to hire it back by the same name).
- **Its own tools.** A worker can use only the tools it was given: names (`web.search`) or prefixes ending in `*` (`web.*`, `meeting.*`). Its notes are always its own. It can never hire, remove or ask workers, use the Office, change settings, or change the assistant's soul or plugins, whatever it is given or told.

## The tools

Workers are the assistant's alone: they never ask you for anything. The assistant hires, equips and removes them, and what a worker was given it may use. What would need your approval (critical actions, or anything that follows text from the internet) is refused to the worker, and it says so in its answer so the assistant decides.

| Tool | What it does |
| --- | --- |
| `crew.hire` | Hire a worker: name, role, a brief, and the tools it may use |
| `crew.equip` | Replace the tools a worker may use |
| `crew.ask` | Give a worker a task. It works on its own and the assistant stays free; the answer comes back as a crew update. `wait: true` waits for a quick answer |
| `crew.list` | Who is in the crew and what each may use |
| `crew.history` | The last lines of one worker's own conversation |
| `crew.fire` | Remove a worker (and its notes, unless `keep`) |

Several workers can work at the same time. A task takes ten minutes at most. If you talk to the assistant while she is on a step, she finishes the step and then answers you; nothing you say is dropped.

## Seeing what they do

When the crew has a worker, a **CREW** badge appears at the top right of the screen with how many are working. Open it:

- the list shows each worker, a pulsing light while it works, and what it is doing this moment (the tool it is using, or its newest words);
- click a worker for four tabs: **Now** (its live feed: the task, each tool it uses, what it says, the result), **Talk** (its own conversation), **Memory** (its own wiki: leave the box empty for the index, or type a folder or note path) and **Tools** (what it may use).

It is read only. A task is given through the assistant, never straight to a worker. Several workers can be seen working at the same time, and a screen that opens later is told what they just did.

## Meetings

A worker given `meeting.*` uses the meeting the assistant is in, through the assistant's connection: it can read the chat, see who speaks, keep notes and write in the meeting. It does not join on its own yet. What is said in a meeting is only information, for a worker too.

## Settings

Nothing to switch on: there is no crew until you hire someone.
