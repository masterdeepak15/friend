# Friend

A self-hosted personal AI assistant. It runs on your PC, talks to you from any screen over WebSocket, uses tools on your machine with risk-based approvals, and controls a full-screen sci-fi "stage" itself.

Phase 1: secure login, agent loop with Claude, CLI device node, approvals with PIN, and a minimal stage with a particle-sphere presence. Phase 2a: chart, gauge, timeline and graph objects, automatic layout, fade-out, orb and ring voice styles and mood intensity. Phase 5a: local voice. Hold Space and speak; Friend answers aloud. Phase 5b: only your voice commands it. Phase 2b: the agent can look through your camera, one approved picture at a time. Also built: memory (notes it keeps about you), tasks and reminders with a heartbeat, free-form pages in an isolated frame, a Docker code sandbox, and a plugin store. Models: Claude, or a local model through Ollama. See `docs/superpowers/specs` and `docs/superpowers/plans`.

## Install (npm)

Needs only **Node.js 20 or newer**. Everything else is checked, and offered, by the setup wizard.

```bash
npm install -g friend-assistant
friend onboard
```

(or without installing: `npx friend-assistant onboard`)

`friend onboard` is a guided setup, one step at a time. Press Enter to take the suggestion at any question; run it again and it carries on where it stopped.

1. **Welcome**: what is about to happen.
2. **What you want to use**: pick any of: Claude through your subscription (Claude Code), Claude with an API key, a model on this PC (Ollama), voice, safe code running (Docker).
3. **What this PC needs**: it checks Node.js, plus only what your choices need: Python (voice), Docker, Ollama, Claude Code, and whether the port is free. For each missing one it shows the exact command (`winget` on Windows, `brew` on a Mac, `apt` on Linux, `npm` for Claude Code), asks **before** installing, runs it one by one with the output visible, and checks again. If a program was installed but this terminal cannot see it yet, it tells you to open a new terminal and run `friend onboard` again.
4. **Your account**: password and PIN (each typed twice) and the assistant's name.
5. **How Friend thinks**: signs in to Claude if needed (`claude auth login`), asks for an API key, or downloads the local model, and sets the safety net (the local model behind Claude).
6. **Voice**: a female or male voice, then the speech models (about 250 MB).
7. **Your workspace folder**, 8. **Who can open Friend** (only this PC, or your network, and the port), 9. **How it looks** (a theme), 10. **Finish**: a summary, and it can start Friend and open the browser.

Handy options: `friend onboard --no-install` (never installs anything, only tells you what to do), `--yes` (take every suggestion), `--redo <step>` (run one step again, for example `--redo look`), `--reset` (start from the beginning). `friend doctor` shows what this PC has and how to fix what is missing, and changes nothing. Progress is kept in `onboarding.json` in the data folder; it never contains a password, PIN or key.

If `npm install` fails on `better-sqlite3` (it builds a small native part when no ready-made one fits your system), install the compiler tools it names (on Windows: the "Desktop development with C++" part of Visual Studio Build Tools) and run it again.

## Command reference

Every command starts with `friend`. If you run Friend from the source code, write `pnpm friend ...` instead. `friend` on its own prints the short list. Most things can also be done inside the app (press Esc, then Settings), and a few have their own commands there (see "Commands inside the app" below).

### Set up and check

| Command | What it does | Use it when |
|---|---|---|
| `friend onboard` | The guided setup in ten steps: asks what you want to use, checks this PC, offers to install what is missing (asking first), creates your account, then the model, voice, workspace, network and look. | The first time, or to finish something you skipped. It is safe to run again: it carries on where it stopped. |
| `friend onboard --no-install` | The same, but never installs anything; it only tells you what to install. | You manage software yourself, or this is a work PC. |
| `friend onboard --yes` | Takes every suggestion without asking (passwords and keys are still asked). | You want the defaults quickly. |
| `friend onboard --redo <step>` | Runs one step again. Steps: welcome, features, prereqs, account, model, voice, workspace, network, look, finish. | You want to change one thing, for example `friend onboard --redo look` or `--redo network`. |
| `friend onboard --reset` | Forgets what the wizard has done so far and starts over. Your account and settings stay. | The wizard's memory of its steps is wrong. |
| `friend doctor` | Shows what this PC has (Node.js, Python, Docker, Ollama, Claude Code, the port) and the exact command to fix what is missing. Changes nothing. | Something does not work, or before asking for help. |
| `friend setup` | Only creates the owner account: password, PIN, assistant name, workspace folder, API key, voice. | You want the plain version without the wizard. |
| `friend status` | Prints the saved settings: data folder, owner, address, public URL, workspace, model, whether an API key is set. | A quick look at how Friend is set up. |
| `friend version` | Prints the version. | Reporting a problem, or checking an update. |

### Run Friend and other PCs

| Command | What it does | Use it when |
|---|---|---|
| `friend start` | Starts Friend: the web app, the assistant, the speech engine if installed, and your connectors. Prints the address (and your network address when that is on). Ctrl+C stops it. Friend's screen works in one browser window at a time: open it in a second place and that window shows "Use here", which moves Friend there and stops the first. | Every day. Open the address in a browser and sign in. |
| `friend pair` | Prints a one-time pairing code, valid for 5 minutes, and the command to run on the other PC. | You want Friend to also work on a second PC. |
| `friend node --url ws://HOST:8787/device --code CODE` | Run on the other PC: connects it to your Friend. Add `--roots C:/work,D:/files` for the folders it may use freely and `--name laptop` to name it. | The second step after `friend pair`. |
| `friend devices list` | Lists the paired PCs and when each was last seen. | Checking what is connected. |
| `friend devices revoke <id>` | Cuts a paired PC off at once. | A PC is lost, sold or no longer yours. |

### Choose the model

| Command | What it does | Use it when |
|---|---|---|
| `friend claude status` | Shows whether Claude Code is installed and signed in, and the model and fallback in use. | Checking the Claude subscription route. |
| `friend claude setup` | Checks that Claude Code is installed and signed in, and tells you what to fix. | You have a Claude plan and want to use it. |
| `friend claude setup --use` | The same, and switches Friend to your Claude subscription (restart `friend start`). | You want Friend to answer through your plan, with no API key. |
| `friend ollama status` | Shows whether Ollama is running, which models are installed, and which one Friend uses. | Checking the local model. |
| `friend ollama setup [model]` | Starts Ollama if needed (in Docker when it is not installed), then downloads the model (default qwen2.5:7b). | You want a free, private model on this PC. |
| `friend ollama setup [model] --use` | The same, and switches Friend to it. | Make the local model the main one. |
| `friend config set provider claude` | Chooses the model by hand: `claude` (API key), `claude-code` (your subscription) or `ollama` (this PC). | You prefer a command to the Settings screen. |
| `friend config set apiKey <key>` | Saves an Anthropic API key. | You use the API route. |

### Voice

| Command | What it does | Use it when |
|---|---|---|
| `friend voice setup` | Installs speech (a private Python environment, Whisper for listening, Piper for speaking), asks which voice you want (female or male) and downloads about 250 MB. | You want to talk to Friend and hear it. |
| `friend voice setup --female` | The same without the question: the first female voice (Amy). `--male` gives Ryan. | You know which kind you want. |
| `friend voice setup --voice jenny` | The same with a voice by name or by its number in the list (`--voice 4`), or any other Piper voice name such as `hi_IN-pratham-medium`. | You want a specific voice. |
| `friend voice list` | Shows the twelve voices (six female, six male), numbered, with the current one marked. | Choosing a voice. |
| `friend voice status` | Shows whether speech is installed, which models it uses, and whether your own voice is enrolled. | Voice does not work, or you want to check. |
| `friend voice forget` | Deletes your saved voice (asks for your PIN). Afterwards every voice is treated as yours until you enrol again. | You want to re-enrol, or switch recognition off. |

### Network and port

| Command | What it does | Use it when |
|---|---|---|
| `friend daemon start` | Runs Friend in the background, with no terminal window needed. Prints the address, keeps a log in the data folder (`friend.log`). | You want Friend always available, even after you close the terminal. |
| `friend daemon stop` | Stops the background Friend and the speech engine with it. | Shutting it down. |
| `friend daemon restart` | Stops it and starts it again. | After changing a setting such as `friend lan on` or a different model. |
| `friend daemon status` | Says whether the background Friend is running, for how long, and at which address. Exit code 0 when running, 1 when not. | Checking, or in a script. |
| `friend lan` (or `friend lan status`) | Shows what Friend listens on and the addresses to open. | Checking, or finding the address for your phone. |
| `friend lan on` | Lets other devices on your network open Friend. Prints the addresses and the things to know (plain http, no microphone on other devices, firewall prompt). | Using Friend from a phone or another PC. |
| `friend lan on --https` | The same, with a secure `https://` address (Friend makes its own certificate), so a phone may use the microphone and camera. | Talking to Friend from a phone. |
| `friend lan https on` (or `off`) | Turns the secure address on or off by itself. | You already ran `friend lan on`, or want plain http back. |
| `friend lan on --port 9100` | The same on another port. | Port 8787 is taken. |
| `friend lan port 9100` | Changes only the port. | Another program uses 8787. |
| `friend lan off` | Back to this PC only. | Closing it again. |

Restart `friend start` after any of these.

### Your data and what Friend may do

| Command | What it does | Use it when |
|---|---|---|
| `friend memory list` | Lists the notes Friend keeps about you, numbered. | Seeing what it remembers. |
| `friend memory forget <number>` | Deletes one note. | A note is wrong or private. |
| `friend memory clear` | Deletes all notes (asks for your PIN). | Starting fresh. |
| `friend rules list` | Lists the "always allow" rules you created by choosing *Always allow* on an approval card. | Reviewing what Friend may do without asking. |
| `friend rules remove <id>` | Removes a rule, so Friend asks again. | You trust something less now. |

### Plugins

| Command | What it does | Use it when |
|---|---|---|
| `friend plugin catalog` | Lists the plugins that come with Friend. | Looking for something to add. |
| `friend plugin list` | Lists the installed plugins and whether each is on. | Checking what is installed. |
| `friend plugin install <name or folder>` | Shows exactly what a plugin contains and asks before installing (add `--yes` to skip the question). A folder path installs your own plugin. | Adding a skill or a sandboxed tool. |
| `friend plugin enable <id>` and `friend plugin disable <id>` | Switches a plugin on or off without removing it. | Pausing a plugin. |
| `friend plugin remove <id>` | Deletes a plugin. | You no longer want it. |

Connectors (Gmail, Chrome control, any MCP service) are managed inside the app, not on the command line: Esc, then Connectors, or `/connectors`.

### Settings by command

`friend config set <key> <value>` changes one setting; `friend config keys` prints the list with a line about each. Anything on the Settings screen can be changed there instead, with the same effect. The keys:

| Key | What it is |
|---|---|
| `provider` | Which model answers: `claude` (API key), `claude-code` (your subscription) or `ollama` (this PC). |
| `apiKey`, `model` | The Anthropic API key and the Claude model used with it. |
| `claudeCode.model`, `claudeCode.command`, `claudeCode.fallback` | The subscription route: model (`sonnet`, `haiku`, `opus`), the command that starts Claude Code, and `ollama` or `none` for what to use when Claude is unavailable. |
| `ollama.url`, `ollama.model`, `ollama.vision`, `ollama.contextTokens` | The local model: server address, model name, whether it can see pictures, and how much it remembers at once. |
| `voice.enabled`, `voice.sttModel`, `voice.ttsVoice`, `voice.language`, `voice.speakTyped`, `voice.accept`, `voice.challenge` | Speech on or off, the listening model, the speaking voice, a forced language, speaking typed replies, and the two thresholds for recognising your voice. |
| `bind`, `port` | Where Friend listens (easier: `friend lan`). |
| `https` | `true` serves a secure `https://` address with a certificate Friend makes for itself, so a phone may use the microphone (easier: `friend lan https on`). |
| `publicUrl`, `allowedOrigins`, `allowedHosts`, `trustProxy` | For running behind your own domain or reverse proxy (see "Using your own domain later"). |
| `roots` | The workspace folders Friend may use freely, separated by commas. |

Example: `friend config set voice.speakTyped false` keeps typed messages silent.

### Environment variables

| Variable | Meaning |
|---|---|
| `FRIEND_HOME` | The folder where Friend keeps its data (default: `.friend` in your home folder). Use another folder to keep a separate test copy. |
| `FRIEND_ANTHROPIC_KEY` | An API key to use when none is saved. |
| `FRIEND_PYTHON` | The Python program to use for voice, if the usual ones are not the right version. |
| `FRIEND_WEB_DIR`, `FRIEND_PLUGIN_CATALOG`, `FRIEND_VOICE_DIR` | Where the web app, the bundled plugins and the Python voice code are, for unusual installs. |
| `FRIEND_DEMO_PORT` | The port `pnpm demo` listens on (default 8788). |

### From the source code

| Command | What it does |
|---|---|
| `pnpm friend ...` | Runs any command above from the repository. |
| `pnpm demo` | A scripted demo with no network and no key; open the printed address. |
| `pnpm test`, `pnpm typecheck`, `pnpm build` | The checks and the web build. |
| `pnpm package` | Builds the npm package in `packages/friend` (then `npm publish` from there). |

### Commands inside the app

Type `/` in the message bar for a list that narrows as you type; they run on the screen and never go to the AI. `/help` opens the same list with a line about each.

| Command | What it does |
|---|---|
| `/settings` | Opens the settings. |
| `/look` | Opens the settings on the voice presence tab (themes, colour, size, captions). |
| `/view minimal`, `/view companion`, `/view workspace` | Chooses how much is on the screen besides the AI's pictures. |
| `/chat`, `/tasks` | Shows or hides the conversation and the schedule (add `on` or `off`). |
| `/layout reset` | Puts every panel back where it started. |
| `/connectors` | Opens the connectors (Gmail, Chrome control, any MCP service). |
| `/plugins` | Opens the plugins. |
| `/voice` | Opens voice enrolment. |
| `/camera on`, `/camera off` | Switches the camera. It only takes a picture when you approve. |
| `/mute`, `/unmute` | Hides or shows everything on the stage. |
| `/clear` | Takes everything off the screen. |
| `/status` | Says what Friend is doing right now. |
| `/logout` | Signs out on this screen. |
| `/lock` | Emergency lock: ends every session and stops the agent. |
| `/help` | Lists the commands. |

## Quick start (from the source code)

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

## Connectors (Gmail, Chrome control, any MCP service)

A connector gives Friend the tools of an outside program or service through the MCP standard. Open **Esc, then Connectors** (or type `/connectors`). Ready-made entries:

- **Chrome control**: one click. Press **Connect**; Friend adds `npx -y chrome-control-mcp` for you (the same as `claude mcp add chrome-control -- npx -y chrome-control-mcp`) and starts it, asking only for your PIN. If it is not installed yet, Friend says so ("please install it first") and can install it in the background (`npx -y chrome-control-mcp setup`). The one step only you can do is loading the extension in Chrome (chrome://extensions, Developer mode, Load unpacked); Friend tells you whether the extension is connected.
- **Gmail**: a community Gmail MCP server (`@gongrzhe/server-gmail-autoauth-mcp`). You create the Google OAuth credentials and sign in on Google's own page; **Friend never sees your Google password**. More mail and calendar connectors can be added the same way ("Something else": any program or any server by address).

How it is kept safe:
- **Adding or switching one on needs your PIN**, and the screen shows exactly which program will start (no shell is ever used) or which address it will reach. Plain `http://` is only allowed for a server on this PC.
- **Every call to a connector's tool asks for your approval** (the usual card; "Always allow" works for the ones you trust). Tools appear to the AI as `mcp.<connector>.<tool>`.
- **Secrets** (tokens, keys) are typed on the screen only. They are saved in `connectors.json` next to the database (readable only by you) and are never shown again, never put in the AI's context, never in the audit log. The AI cannot supply or change secrets.
- **What comes back is data, not orders.** The AI is told that email, web pages and documents from a connector are untrusted and that it must never send or delete anything unless you asked for exactly that.
- A connector that stops working shows why; it is started again on the next use. Friend does not wait for connectors when it starts.
- Turning one off removes its tools at once. Removing deletes its saved secrets.

**The AI can manage connectors too.** Ask it to "connect X", "switch Gmail off", "reload Chrome control" or "remove it". Adding or switching on shows the same PIN card with the exact program; turning off and reloading need nothing; removing asks. Opt-in live check of the real chrome-control: `FRIEND_LIVE_CHROME=1 pnpm exec vitest run packages/server/src/connectors/live.test.ts`.

## The AI writes its own skills and plugins

When it notices something you repeat, the AI may suggest a **skill** (instructions it loads later) or a **plugin tool** (a small python, node or shell program that runs in the code sandbox: no network, no access to your files, approval on every call). If you agree it calls `plugins.create`: the approval card shows **everything it wrote, untruncated**, and needs your PIN. It is then checked like any plugin, switched on and loaded straight away (`plugins.reload` re-reads everything; the Plugins panel has a **Reload plugins** button too). Creating the same id again installs a newer version. The AI can also list, switch off or on, and delete plugins.

## Commands

`/help` opens the list of every command with what it does.

## On-screen status, clock and settings

- **Status line (bottom-left):** always shows what Friend is doing in plain words: Ready, Listening, Understanding what you said, Thinking, Getting the weather for Pune, Creating a view, Running a command, Answering, Waiting for your approval, Reconnecting. It never shows command text or arguments.
- **Clock (bottom-right):** a small date and time, so the screen is never empty.
- **Settings (Esc, then Settings):** change the model provider (Claude subscription through Claude Code, Claude API key, or local Ollama), the model names, the fallback, the Ollama address, and the voice options without the terminal. A change is used straight away (no restart) except the speaking voice and listening model. Saving needs your PIN. The API key is write-only: it is never sent back to the screen. Network address, folders and safety rules are deliberately not in this screen; use `friend config set` for those.
- **Slash commands:** type `/` in the message bar for a list that narrows as you type (arrows or Tab to pick, Enter to run): /settings, /plugins, /voice, /camera on|off, /mute, /unmute, /clear, /status, /logout, /lock, /help. They run on the screen and never go to the AI, so they work instantly and even when the model is down. Start a line with // to send a message that begins with a slash.
- **PIN with the keyboard:** wherever a PIN is asked for, type the digits, Backspace to correct, Enter to confirm (Enter never deletes your voice; that needs a click). The on-screen keys still work for touch.
- **The AI knows the screen:** its instructions include a layout guide (what is always on screen, the five regions, how to compose one answer, how long things should stay), and every request tells it what is on screen, where, for how long, and which regions are free. If it puts something on top of another object or over the captions, status line or clock, Friend moves it to a free spot (or the tidy auto grid) and tells it why, so it learns within the conversation. Nothing is refused.
- **Voice presence look (Settings, tab "Voice presence", or `/look`):** the settings dialog is wide and has tabs: *Model*, *Voice* and *Voice presence*. On the last one you choose a **theme** (Aurora, Ocean, Ember, Violet storm, Matrix, Rose, Ghost) with one click, or set everything yourself: the **shape** (sphere, orb, ring), the **colour** (swatches or any colour), **brightness**, **size**, how strongly it **reacts to the voice**, the soft **glow** behind everything, whether the live **captions** show and how big they are, and the **view**. A live preview shows the result before you save. Saving a change of look needs **no PIN**, and every open screen changes at once. *Let the AI change the shape, colour and brightness to suit a topic* can be switched off to keep exactly the look you chose (you can still ask it "make it purple" yourself). Pressing the colour box also works; the colour must be a plain #rrggbb.
- **Views and panels:** Esc, then **View** (or `/view minimal|companion|workspace`, or Settings) chooses how much is on the screen besides the AI's pictures. *Minimal*: only the voice presence (this hides the status line and the clock too; the Esc menu's View button never switches to it by accident, only Settings or `/view minimal` do, and Friend tells you once when the view is Minimal). *Companion*: plus the status line and clock. *Workspace*: also a **Chat** panel (what was said and answered, with a box to type in) and a **Schedule** panel (open tasks and reminders, soonest first, late ones in red). Turn any panel on or off from the Esc menu or with `/chat`, `/tasks`. **Drag a panel by its title bar** (or the status line and clock anywhere on them) to move it; arrow keys nudge it, double-click puts it back, `/layout reset` puts all back. Panels remember their place in this browser. Changing the view starts from that view's own set of panels.
- **The AI can change settings too:** ask it to switch the model, the fallback or the voice options, or to show a cleaner or fuller screen. Changing settings is a PIN-approval action (the same card as for any risky action); changing only the view needs no PIN. It can never change the API key or the Claude Code command (those stay on the settings screen), and a change of model takes effect after its current reply. The AI is also told which panels you have open and keeps its pictures out of their way.

## Voice (local, optional)

```bash
pnpm friend voice setup     # one time: private Python environment + speech models (about 250 MB)
pnpm friend start           # starts the speech engine too
```

Hold **Space** (or long-press the screen) and speak; release to send. Friend answers in captions and aloud, and the sphere follows the real audio. Pressing Space while it talks interrupts it. Typed messages are answered silently.

- **Female or male voice.** Twelve voices to choose from, six female and six male, American, British and Scottish (Amy, Kristin, Hannah, Jenny, Alba, Kathleen; Ryan, Joe, Norman, Henry, Alan, Tom), plus the original voice (Lessac), which stays the default until you choose. You are asked at `friend setup` ("female or male") and again at `friend voice setup` (a number, `female` or `male`; or skip the question with `--female`, `--male` or `--voice jenny`). `friend voice list` shows them. Later, in **Settings, Voice tab**, pick one from the list and press **Hear it** to listen before you decide; the change needs no restart: the voice loads in the background (the first time a voice is used it downloads about 60 MB, then it works offline), you get a message when it is ready, and if it cannot be loaded Friend goes back to the previous voice instead of going silent. Any other Piper voice works too: `friend voice setup --voice hi_IN-pratham-medium`.
- Everything runs on your PC: speech to text with faster-whisper, text to speech with Piper. Recordings are never stored or sent anywhere else.
- Needs Python 3.10 or newer. `friend voice status` shows the state; `friend config set voice.sttModel small` (or `voice.language hi`, `voice.enabled false`) changes it, then run `friend voice setup` again for new models. The speaking voice is chosen as described above.
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

## Another port, and other devices on your network

By default Friend is reachable only on this PC, at http://127.0.0.1:8787.

```bash
pnpm friend lan                 # shows how it is set up and the addresses
pnpm friend lan on              # also reachable from phones and other PCs on your network
pnpm friend lan on --https      # the same, with a secure address so a phone can use the microphone
pnpm friend lan https on        # (or off) only the secure address
pnpm friend lan on --port 9100  # the same, on another port
pnpm friend lan port 9100       # change only the port
pnpm friend lan off             # this PC only again
```

Restart `friend start` afterwards. It then prints the addresses, for example `Also on your network: http://192.168.1.20:9100`; open that on the other device and sign in. Things to know:

- Anyone on the network can open the sign-in page. The password and PIN still guard everything, so use a strong password. Creating the owner account is only possible on this PC.
- Over plain http other people on the network could read the connection. Use it on a network you trust, turn on the secure address (below), or put Friend behind your own HTTPS (`publicUrl`, below).
- **Browsers allow the microphone and camera only on localhost or HTTPS.** Over plain http on a phone you can type and read, but not talk. Run `friend lan https on` and restart: Friend makes its own certificate and serves `https://192.168.x.x:8787`. The first time, the phone warns that the certificate is not from a known authority (Android Chrome: Advanced, Proceed; iPhone Safari: Show Details, visit this website). After that the microphone works. The warning appears because the certificate is Friend's own, not bought from an authority; the traffic is still encrypted.
- **On a phone** the screen shows a round microphone button (hold it and let go to send, or tap once to start and again to send), a keyboard button and a menu button. There is no Space or Esc to press.
- Windows asks once whether to let Node.js through the firewall: allow it on *Private* networks.
- To open it by a name (`http://my-pc:9100`) add the name: `friend config set allowedHosts my-pc`.

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
