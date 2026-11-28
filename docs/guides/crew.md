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
- a worker that handles a mailbox or a meeting says so in its header;
- click a worker for four tabs: **Now** (its live feed: the task, each tool it uses, what it says, the result), **Talk** (its own conversation), **Memory** (its own wiki as a tree: folders fold and unfold, a click opens a note, and each entry shows its one-line summary) and **Tools** (what it may use).

It is read only. A task is given through the assistant, never straight to a worker. Several workers can be seen working at the same time, and a screen that opens later is told what they just did.

### Who said what

Every message in the team feed (the Feed instrument of the orbital screen, opened or small, and the crew panel) is shown under the name of the person it belongs to. Each person has a colour and initials of their own that stay the same everywhere: Office workers are hexagons, crew workers are rounded squares, you and Friend are round. A run of lines from one person is one block with their full name, their kind (OFFICE, CREW, YOU, FRIEND) and role, and each line has its time and a mark for what it is (a tool, a result, a warning). A key at the top lists everyone in the feed, and the one who is at work now pulses.

## Giving a mailbox or a meeting to a worker

By default the assistant handles every mailbox and meeting. You can give one to a crew worker, or take it back, in two ways:

- **From the screen:** Plugins, Mailboxes. Each mailbox has **Handled by**: *The assistant* or a crew worker. (It shows once there is a crew.)
- **By asking:** "Ada handles the support mailbox", "Ben attends meeting 4" (`crew.assign`). "Give support back to yourself" takes it back.

From then on the mail that arrives in that mailbox (and what is said in that meeting) is handled by the worker, with its own conversation, its own memory and its own tools; the assistant's conversation is not used. The rules stay the same as for the assistant: only mail from you can give an order, a mail from someone else is information and never an order, and a worker handling a mail can only use the mail tools of that mailbox, whatever else it was given.

A worker never asks you. When it has to do something that would need your approval (send a mail to someone new, say), it stops and the assistant is told what and why; she decides, or tells you. If the worker is busy, the mail waits, as it does for the assistant. Removing a worker gives its mailboxes and meetings back to the assistant.

In a meeting the worker appears under the name the meeting already has (the assistant's), so nobody has to learn a new name.

## Meetings

A worker given `meeting.*` uses the meeting the assistant is in, through the assistant's connection: it can read the chat, see who speaks, keep notes and write in the meeting. It does not join on its own yet. What is said in a meeting is only information, for a worker too.

## Settings

Nothing to switch on: there is no crew until you hire someone.
