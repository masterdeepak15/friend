# Backlog: owner's findings (2026-10-08)

Noted as the owner sent them. Nothing here is built yet; each item has a first proposal to decide on.

## 1. The AI can change settings itself (DONE: settings.get, settings.set with PIN approval, view.set)
"Settings screen can also be controlled by our AI."
- Proposal: a `settings.get` tool (free) and a `settings.set` tool that goes through the same `applySettings` validation as the screen.
- Safety: always asks for approval with the PIN (it can change which program runs and where words go); the API key and the Claude Code command stay screen-only; never allowed for guests.

## 2. Chat window, shown on request, arrangeable (DONE: chat panel, draggable panels, three views chosen in Settings, /view /chat /layout)
"If the user wants to see what we chat. Arrange things by drag and drop. Pick the view in settings."
- A chat/history panel (typed and spoken turns, tool steps in plain words), hidden by default, opened by a button or "show our chat".
- Panels (chat, tasks/schedule, status, clock, agent objects) can be dragged and resized; the layout is saved per owner.
- Settings picks the default view: Minimal (orb only), Companion (orb + status + clock), Workspace (chat + tasks + objects).

## 3. Design skill for the AI (screen layout sense) (DONE: guide, screen description, placement checker; zones with fixed panels come with the layout system, item 2)
"The AI does not understand the screen view: where to show what, what stays, what is temporary."
- Give the model a screen model in its prompt: the free regions and their purpose, the sizes, what is already on screen (it has `stage.summary()` today, but no layout rules).
- Zones: permanent (status, clock, schedule strip), session (current answer visuals), temporary (alerts, reminders, with a time to live).
- Rules as a plugin-style "design skill": one hero object per answer, max N objects, charts left/centre, details right, remove what is stale, never cover the orb or the corner widgets, prefer pictures to text.
- Server side: placement validator that refuses overlap with permanent zones and picks a free slot (the existing "auto" placement can be extended).

## 4. Tasks and schedule always reachable (DONE: schedule panel, Esc menu buttons, /tasks)
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

## 7. Connectors, AI-made plugins, /help (DONE; owner's message of 2026-10-08)
- DONE: /help list; MCP connectors (stdio and http) with PIN to add/switch on, approval on every call, secrets kept private; AI tools connectors.* and plugins.* (create, reload, enable, disable, remove); presets for Chrome control and Gmail.
- Later: more presets (Google Calendar, Outlook, Slack…); per-tool permissions (mark a connector's read-only tools as allowed without asking); OAuth inside Friend instead of per-server login; show connector tools by name in a panel; tool-count limits for small local models.

## 8. TO CHECK LATER: the bottom corners (owner's note, 2026-10-08)
- The message bar ("Talk to me") sits at the bottom centre. The owner thinks the status line (bottom-left) and the clock (bottom-right) now hide behind it. Not investigated yet, to be looked at together.
- First guesses: on a narrow window the bar is almost full width (min(640px, 100% - 24px)) and covers both corners; the corner orb and the status line also compete for the bottom-left; the movable widgets may be saved at a position under the bar.
- Idea if confirmed: lift the two widgets above the bar while it is open (or put the bar above them), and keep the three from overlapping at any width.

## 9. LAN and port (DONE)
- `friend lan on|off|port N`, startup prints the network addresses, `bind` is validated, real test through the PC's network address.
- Later: a Network section in the settings screen (needs the PIN and a restart note); HTTPS for the microphone on other devices; pairing a phone by QR code.

## Suggested order
1. PIN with keyboard, and the slash-command bar (both small, both useful at once; the commands become the base for items 2 and 4).
2. Screen model + design rules for the AI, with the placement validator (item 3).
3. Layout system with draggable panels and saved view presets (items 2 and 4 depend on it).
4. Chat panel and schedule panel inside that layout.
5. AI-controlled settings tools (item 1).
