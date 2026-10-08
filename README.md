# Friend

A self-hosted personal AI assistant. It runs on your PC, talks to you from any screen over WebSocket, uses tools on your machine with risk-based approvals, and controls a full-screen sci-fi "stage" itself.

Phase 1: secure login, agent loop with Claude, CLI device node, approvals with PIN, and a minimal stage with a particle-sphere presence. Phase 2a: chart, gauge, timeline and graph objects, automatic layout, fade-out, orb and ring voice styles and mood intensity. Phase 5a: local voice. Hold Space and speak; Friend answers aloud. Phase 5b: only your voice commands it. Phase 2b: the agent can look through your camera, one approved picture at a time. Also built: memory (notes it keeps about you), tasks and reminders with a heartbeat, free-form pages in an isolated frame, a Docker code sandbox, and a plugin store. Models: Claude, or a local model through Ollama. See `docs/superpowers/specs` and `docs/superpowers/plans`.

## Quick start (development)

```bash
pnpm install
pnpm build                 # builds the web client
pnpm friend setup          # password, PIN, assistant name, workspace folder, API key
pnpm friend start          # gateway + local device node, http://127.0.0.1:8787
```

Open the address in a browser, sign in, and press any key to talk. Press `Esc` (or long-press the top-left corner) for the owner menu: mute stage, log out, emergency lock.

Preview the whole look with no API key and no network: `pnpm build && pnpm demo`, then open the printed address. Each message you send shows the next scene (gauges and charts, a timeline, a graph, the orb and ring voice styles, a warm mood).

Other commands: `friend rules list|remove <id>`, `friend devices list|revoke <id>`, `friend status`, `friend config set <key> <value>`, `friend pair` (code to connect another PC), `friend node --url <ws-url> --code <code>`.

## Use your Claude subscription (Claude Code)

Instead of an API key you can let Friend think through the Claude Code app you already have signed in with your Claude plan. To the rest of Friend it is just another model: same tools, same approvals, same screen. Nothing else changes.

```bash
claude                          # once: sign in with your Claude account (if you have not already)
pnpm friend claude setup --use  # checks it works and switches Friend over; restart `friend start`
pnpm friend claude status
```

- One Claude Code process stays running, so replies start in about a second after the first message (a fresh start takes 3 to 9 seconds). Friend's conversation is remembered across restarts.
- Claude Code has no tools of its own here. Friend's tools reach it through a private local bridge (127.0.0.1, random token), and every call still goes through Friend's own approval and PIN rules and audit log.
- Unrecognized voices (guests) get a separate, tool-less, nothing-saved session.
- If your plan's usage limit runs out, Claude Code is signed out or missing, Friend answers with the local Ollama model and tells you once on screen (`friend config set claudeCode.fallback none` to see errors instead). Other settings: `claudeCode.model` (default sonnet), `claudeCode.command`.
- Caveats: it uses your plan's limits; using a subscription this way is a grey area in Anthropic's terms, so treat it as experimental; if Friend answered through the fallback, Claude does not know about that exchange.
- Opt-in live test against the real CLI: `FRIEND_LIVE_CLAUDE=1 pnpm exec vitest run packages/server/src/provider/claude-code/live.test.ts`.

## On-screen status, clock and settings

- **Status line (bottom-left):** always shows what Friend is doing in plain words: Ready, Listening, Understanding what you said, Thinking, Getting the weather for Pune, Creating a view, Running a command, Answering, Waiting for your approval, Reconnecting. It never shows command text or arguments.
- **Clock (bottom-right):** a small date and time, so the screen is never empty.
- **Settings (Esc, then Settings):** change the model provider (Claude subscription through Claude Code, Claude API key, or local Ollama), the model names, the fallback, the Ollama address, and the voice options without the terminal. A change is used straight away (no restart) except the speaking voice and listening model. Saving needs your PIN. The API key is write-only: it is never sent back to the screen. Network address, folders and safety rules are deliberately not in this screen; use `friend config set` for those.
- **Slash commands:** type `/` in the message bar for a list that narrows as you type (arrows or Tab to pick, Enter to run): /settings, /plugins, /voice, /camera on|off, /mute, /unmute, /clear, /status, /logout, /lock, /help. They run on the screen and never go to the AI, so they work instantly and even when the model is down. Start a line with // to send a message that begins with a slash.
- **PIN with the keyboard:** wherever a PIN is asked for, type the digits, Backspace to correct, Enter to confirm (Enter never deletes your voice; that needs a click). The on-screen keys still work for touch.
- **The AI knows the screen:** its instructions include a layout guide (what is always on screen, the five regions, how to compose one answer, how long things should stay), and every request tells it what is on screen, where, for how long, and which regions are free. If it puts something on top of another object or over the captions, status line or clock, Friend moves it to a free spot (or the tidy auto grid) and tells it why, so it learns within the conversation. Nothing is refused.
- **Views and panels:** Esc, then **View** (or `/view minimal|companion|workspace`, or Settings) chooses how much is on the screen besides the AI's pictures. *Minimal*: only the voice presence. *Companion*: plus the status line and clock. *Workspace*: also a **Chat** panel (what was said and answered, with a box to type in) and a **Schedule** panel (open tasks and reminders, soonest first, late ones in red). Turn any panel on or off from the Esc menu or with `/chat`, `/tasks`. **Drag a panel by its title bar** (or the status line and clock anywhere on them) to move it; arrow keys nudge it, double-click puts it back, `/layout reset` puts all back. Panels remember their place in this browser. Changing the view starts from that view's own set of panels.
- **The AI can change settings too:** ask it to switch the model, the fallback or the voice options, or to show a cleaner or fuller screen. Changing settings is a PIN-approval action (the same card as for any risky action); changing only the view needs no PIN. It can never change the API key or the Claude Code command (those stay on the settings screen), and a change of model takes effect after its current reply. The AI is also told which panels you have open and keeps its pictures out of their way.

## Voice (local, optional)

```bash
pnpm friend voice setup     # one time: private Python environment + speech models (about 250 MB)
pnpm friend start           # starts the speech engine too
```

Hold **Space** (or long-press the screen) and speak; release to send. Friend answers in captions and aloud, and the sphere follows the real audio. Pressing Space while it talks interrupts it. Typed messages are answered silently.

- Everything runs on your PC: speech to text with faster-whisper, text to speech with Piper. Recordings are never stored or sent anywhere else.
- Needs Python 3.10 or newer. `friend voice status` shows the state; `friend config set voice.sttModel small` (or `voice.language hi`, `voice.ttsVoice <piper voice>`, `voice.enabled false`) changes it, then run `friend voice setup` again for new models.
- Recordings are limited to 90 seconds and 4 MB. While Friend is busy with a request, a new recording is refused (409) instead of being dropped silently. Emergency lock also cancels a recording that is still being transcribed.
- The browser needs microphone permission and a secure origin (localhost, or HTTPS through your domain).
- **Until you enroll your voice, anyone who can press Space on a logged-in browser speaks as you.** The PIN still guards risky actions.

### Only your voice commands Friend (speaker verification)

Press **Esc** (or long-press the top-left corner), choose **Enroll my voice**, read the phrases aloud and enter your PIN. Friend keeps only an averaged 256-number voiceprint, encrypted on disk (AES-256-GCM, key in `voice.key` next to the database). Recordings are never kept. After that every spoken request is scored against your voiceprint:

| Match | What happens |
|---|---|
| Your voice (0.72 or higher) | Runs as you, as before. |
| Close, or too short to tell (0.58 to 0.72) | Nothing runs. A card asks "Was that you?"; the right PIN runs the words, a wrong PIN (3 tries), Dismiss or 60 seconds drops them. |
| Another voice (below 0.58) | A guest: polite answer, no tools, none of your conversation or screen, nothing saved. You get a warning with what was said. |

- `friend voice status` shows whether a voice is enrolled; `friend voice forget` deletes it after the PIN (so does the enrollment panel). `friend config set voice.accept 0.75` and `voice.challenge 0.6` tune the two thresholds.
- Emergency lock drops any pending challenge and any enrollment in progress.
- A voice match is a convenience, not a lock: a recording or a cloned voice can fool any speaker model. That is why a borderline match needs the PIN and risky actions always ask for it.
- Python tests for the speech engine: `cd packages/voice && python -m venv .venv && .venv/Scripts/pip install -e .[dev] && .venv/Scripts/python -m pytest`.

## Pictures first: weather, stats and graphics

Friend is meant to show answers, not only say them. It controls the whole screen and picks the object that fits (gauge, chart, table, timeline, graph, or its own animated page).

- **Weather:** "what is the weather in Pune?" gets live data from Open-Meteo (no account or key) and puts temperature, humidity, wind and a 24-hour chart on screen.
- **Computer stats:** "how is my computer doing?" puts CPU load, memory and disk gauges, uptime and CPU on screen.
- For these two, Friend calls the tools **itself** as soon as the request is clear (a named city, or a computer word plus a status word), so the graphs appear immediately even with a small local model; the model then only says a short summary. Asked together, both sets stay on screen. Anything else is decided by the model, which is told never to invent numbers and never to announce an action without doing it (if a small model does, Friend asks it once to actually call the tool).

## Voice replies

Friend answers aloud to **both** spoken and typed messages (`friend config set voice.speakTyped false` to keep typed ones silent). The voice follows the text: each sentence is spoken as soon as it is written, and code blocks are never read aloud.

Browsers keep sound blocked until the page has had a click, tap or key press. Friend unlocks sound on the first one anywhere on the page, and shows a one-time hint if sound is still blocked. Needs `friend voice setup` once, and a restart of `friend start` afterwards.

## Memory

Tell Friend "remember that my sister is Priya" and it keeps a short note. The 20 newest notes are in front of the model in every conversation; older ones are found on demand ("what do you know about Priya?").

- Up to 200 notes of 500 characters each, stored in the local database. When full it refuses and asks you to forget something; it never drops notes silently.
- You control all of it: `friend memory list`, `friend memory forget <number>`, `friend memory clear` (asks for the PIN). You can also just say "forget note 7".
- Notes are treated as **data about you, never as instructions**, so text inside a note (or text a web page tricked the agent into saving) cannot give the agent orders. Guests and unrecognized voices never see your notes. The agent is told never to save passwords, PINs or keys.

## Plugins

Plugins add **skills** (instructions the agent loads when they fit, for example "write my stand-up") and **tools** (small programs the agent can call, for example an exact unit converter). Three examples are bundled in `plugins/`: `unit-converter`, `standup-writer`, `rubber-duck`.

- Manage them from the screen (Esc, then **Plugins**) or the terminal: `friend plugin catalog | list | install <name|folder> | enable <id> | disable <id> | remove <id>`.
- **Installing shows what is inside and needs your confirmation (the PIN in the browser).** Switching a plugin on needs the PIN too; switching off and removing do not.
- A plugin's tools can never be more powerful than the code sandbox: they run in a throwaway Docker container (no network, no access to your files, time and memory limits), get their arguments as `/work/args.json`, and **ask for your approval on every call**. Skills are text only: they give the model words, never power, and cannot override your rules or the approval system.
- Plugins are validated strictly (lowercase ids, size and file-count limits, no links, every file must be inside the plugin folder) and re-validated each time Friend loads; a broken plugin is switched off with a visible reason.
- Make your own: a folder with `plugin.json` plus the files it names, then `friend plugin install ./my-plugin`. See `docs/superpowers/specs/2026-10-08-friend-plugins-design.md` for the format. Downloading plugins from the internet is deliberately not supported yet (it needs signed packages to be safe).

## Running code safely (Docker)

The agent can write a program (Python, Node or shell), run it, and read the result: calculations, data crunching, quick experiments. It needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) running; without it the tool says so and nothing runs. (Windows Sandbox is not needed, so Windows Home works.) The first use of each language downloads a small image (about 50 MB), so that one run needs internet; after that it works offline.

Every run asks for your approval, and the card shows the **whole program**. Each run is its own throwaway container:

- `--network none`: no internet and no DNS; it cannot send anything anywhere.
- It sees none of your files: only its own code is mounted, read-only. The root filesystem is read-only; only a 64 MB scratch `/tmp` is writable.
- Not root (user 65534), all capabilities dropped, `no-new-privileges`, 512 MB memory (no swap), 1 CPU, at most 128 processes.
- A time limit (10 s by default, 60 s at most); after that the container is killed and removed. Output is cut at 20,000 characters.

`pnpm test` includes a check against real containers that runs hostile code (network attempts, writes outside `/tmp`, memory hog, endless loop, fork bomb) and confirms each is stopped.

## Free-form pages (sandbox)

When none of the standard objects fits, the agent can draw its own small page on the stage: a custom visualization, a calculator, a timer, a game. It is HTML, CSS and JavaScript written inline (up to 100,000 characters) and runs in an isolated frame:

- `sandbox="allow-scripts"` without `allow-same-origin`, so the page has an empty origin: it cannot read your session, storage or the app, cannot call Friend's APIs, navigate the window, open popups or submit forms.
- A fixed Content-Security-Policy placed before anything the agent wrote: `default-src 'none'` (no network of any kind, no external scripts, fonts or frames), inline script and style only, images only as `data:` URLs.
- The app never listens for messages from the frame, and every object has a dismiss (×) button.
- Checked in a real browser: the demo's page tries `fetch`, `parent.document` and `localStorage` and reports each as blocked (`pnpm demo`, fifth message).

## Tasks and reminders

Say "remind me in 30 minutes to call the bank", "remind me tomorrow at 5pm to send the report", "every Monday at 9 remind me to back up" (hourly, daily or weekly repeats), or just "add milk to my list". "What is on my list?" shows your open tasks; "done with 3" or "remove 4" tidies up.

- A **heartbeat** inside the server checks every 15 seconds. When a reminder is due, an alert appears, a red card shows on the stage for 90 seconds and Friend says it aloud (when voice is set up).
- A reminder **only notifies you**. It never starts a conversation with the model and never runs a command on its own, so nothing happens on your PC while you are away.
- If no screen is open (or Friend is mid-conversation) the reminder waits and is shown as soon as you are back. A repeating task skips any slots it missed instead of replaying them.
- Times need no special format: Friend knows your local time and converts. Up to 200 open tasks.

## Camera (owner-controlled)

Ask "what is this?" while you hold something up to the camera, and Friend can look. It works one picture at a time:

1. The camera is **off** until you turn it on: press **Esc**, choose **Camera: off** (it becomes **Camera: on**). The switch is not remembered; a reload turns it off again.
2. When the agent wants to look it calls `camera.snap`, and an approval card appears: "Take one picture with the camera and show it to the AI model". There is no "Always allow" for the camera.
3. After you approve, the browser opens the camera, takes one frame (JPEG, longest side 1024 px), closes the camera and uploads the frame. While the camera is open a red **Camera on** badge with a small live preview shows in the corner; the agent cannot hide it.

- The picture is shown to the model for that turn only. It is never written to disk, never saved in the conversation history (history keeps "[camera picture, not kept]"), and the audit log records only its size. Guests can never use the camera.
- Emergency lock, logout, switching the camera off, or closing the page cancels a pending request and releases the camera.
- **With Claude as the provider the picture is sent to Anthropic's API.** With Ollama it stays on your PC, but only a vision model can use it: `ollama pull llava` (or another vision model), then `friend config set ollama.model llava` and `friend config set ollama.vision true`. Note a vision model may not support tools, so Claude is the practical choice today. Without vision the tool says so before it asks you.
- Like the microphone, the camera needs `localhost` or HTTPS.
- Text inside a picture is treated as data, never as instructions.

## Safety model

- Reading is free, writing inside your workspace is free, shell commands ask first, destructive commands ask and need your PIN.
- Approval cards and the PIN pad are drawn by the client, never by the agent.
- Everything the agent does is written to the audit log.

## Using your own domain later

Run Friend behind a reverse proxy (for example Caddy) and set:

```bash
friend config set publicUrl https://friend.example.com
friend config set trustProxy true
friend config set allowedOrigins https://friend.example.com
```

Login, PIN, rate limits and lockout stay on in every mode. Phones need HTTPS to use the microphone and camera in later phases, which the domain setup provides.

## Tests

```bash
pnpm test        # all packages
pnpm typecheck
```

`scripts/smoke.md` lists the manual end-to-end checks and their last results.
