# Backlog: owner's findings (2026-10-08)

Noted as the owner sent them. Nothing here is built yet; each item has a first proposal to decide on.

## 1. The AI can change settings itself
"Settings screen can also be controlled by our AI."
- Proposal: a `settings.get` tool (free) and a `settings.set` tool that goes through the same `applySettings` validation as the screen.
- Safety: always asks for approval with the PIN (it can change which program runs and where words go); the API key and the Claude Code command stay screen-only; never allowed for guests.

## 2. Chat window, shown on request, arrangeable
"If the user wants to see what we chat. Arrange things by drag and drop. Pick the view in settings."
- A chat/history panel (typed and spoken turns, tool steps in plain words), hidden by default, opened by a button or "show our chat".
- Panels (chat, tasks/schedule, status, clock, agent objects) can be dragged and resized; the layout is saved per owner.
- Settings picks the default view: Minimal (orb only), Companion (orb + status + clock), Workspace (chat + tasks + objects).

## 3. Design skill for the AI (screen layout sense)
"The AI does not understand the screen view: where to show what, what stays, what is temporary."
- Give the model a screen model in its prompt: the free regions and their purpose, the sizes, what is already on screen (it has `stage.summary()` today, but no layout rules).
- Zones: permanent (status, clock, schedule strip), session (current answer visuals), temporary (alerts, reminders, with a time to live).
- Rules as a plugin-style "design skill": one hero object per answer, max N objects, charts left/centre, details right, remove what is stale, never cover the orb or the corner widgets, prefer pictures to text.
- Server side: placement validator that refuses overlap with permanent zones and picks a free slot (the existing "auto" placement can be extended).

## 4. Tasks and schedule always reachable
"User wants to see the scheduled tasks."
- A small schedule strip/panel (next reminders and open tasks), opened by an option button, by Esc menu, or by voice ("what is scheduled?").
- Option buttons: a row of quick actions the user can click or say (Tasks, Chat, Weather, Stats, Settings), hidden or shown from Settings, also reachable from the Esc menu.

## 5. PIN entry must work with the keyboard (DONE)
"Now it is only click."
- Quick fix, small: the PIN pad accepts digits, Backspace and Enter from the keyboard (focus it when it opens). Applies to approvals, challenge, plugins, settings, enrollment.
- Keep the on-screen keys for touch.

## 6. Slash commands in the command bar (DONE: first set)
"Better to make /commands so I can enter /settings, /something."
- Typing `/` in the command bar shows a small list that filters as you type; Enter or click runs it. These run on the client or the server directly and never go to the AI model, so they are instant, free and work even when the model is down.
- First set: /settings, /chat, /tasks (schedule), /plugins, /camera on|off, /mute, /clear (clear the stage), /status, /voice, /help, /lock (emergency lock). Later: /model claude-code|claude|ollama, /layout minimal|companion|workspace.
- The same commands appear as the option buttons (item 4) and in the Esc menu, so there is one list behind all three.
- Anything that needs the PIN (like /model) still asks for it. The AI can offer commands but a slash command is always typed or clicked by the owner.

## Suggested order
1. PIN with keyboard, and the slash-command bar (both small, both useful at once; the commands become the base for items 2 and 4).
2. Screen model + design rules for the AI, with the placement validator (item 3).
3. Layout system with draggable panels and saved view presets (items 2 and 4 depend on it).
4. Chat panel and schedule panel inside that layout.
5. AI-controlled settings tools (item 1).
