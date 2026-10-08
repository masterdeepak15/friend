# Friend Phase 1 smoke checklist

Run against a built app (`pnpm build`) with a real Anthropic key. Tick each line by hand.

| # | Success criterion (spec section 1) | How to check | Result 2026-10-07 |
|---|---|---|---|
| 1 | First run creates the owner (password, PIN, assistant name) | Open `http://127.0.0.1:8787` on the PC, fill the setup screen | PASS (browser) |
| 2 | Log in, type a request, reply shows as captions on the stage | Sign in, press any key, send a message | PASS for login, typing, captions and the no-key notice; model reply needs a real key, covered by the scripted e2e test |
| 3 | Read tool runs without asking; shell asks on a client card; destructive needs PIN | Ask: "list my workspace", "run git status", "delete the folder x" | Covered by integration tests (`integration.test.ts`); live run with a key still to do |
| 4 | Agent shows, updates and hides objects and switches scenes | Ask: "show my disk usage as a stat card, then clear the screen" | Covered by integration and e2e tests; live run with a key still to do |
| 5 | Particle sphere animates idle, thinking, speaking and reacts to amplitude | Watch the sphere while sending a message | PASS for idle and phone layout (screenshots); thinking and speaking states unit-tested, brief to see by eye |
| 6 | A stranger without credentials reaches nothing | `curl` the WebSocket with no cookie: closes 4401; `POST /api/setup` after setup returns 403 | PASS (gateway and e2e tests) |
| 7 | Every tool call, approval and login is audited | `friend status`, then inspect `audit_log` in `~/.friend/friend.db` | PASS (integration test asserts rows) |
| 8 | Works at phone width and is ready for a domain | Resize to about 420 px wide; set `publicUrl`/`trustProxy` and put Caddy in front | Phone width PASS (screenshot, owner menu works); domain setup is config only, not exercised yet |

## Known gaps to close before calling Phase 1 shipped

- Live model run (rows 3 and 4) needs `friend config set apiKey <key>`.
- Thinking and speaking presence states were not captured in screenshots.

## Phase 2a (stage visuals) manual check

Run `pnpm build && pnpm demo` and send five messages. Results 2026-10-08 on a 1920 px wide window:

| Scene | What to see | Result |
|---|---|---|
| 1 Overview | three gauges (cyan, amber at 83%, red at 97%), two-series area chart with legend, stat; sphere shrinks to the corner | PASS |
| 2 Plan | timeline with glowing rail, list with a struck-through item, table | PASS |
| 3 Services | graph fits its card, arrowheads end at node borders; ring voice style in the corner | PASS |
| 4 Orb | warm amber orb with ripple rim, alert card expires after 20 s | PASS (a seam in the shader and an oversized card were found and fixed) |
| 5 Reset | back to the cyan sphere | PASS |

Not checked by eye: phone width for the new objects (the test browser window could not be resized; the stacking logic is unit tested), and the thinking/speaking looks of the orb and ring.

## Phase 5a (voice I/O) check

Results 2026-10-08:

| Check | How | Result |
|---|---|---|
| Installer works on a clean data folder | `FRIEND_HOME=<temp> friend voice setup` (venv, packages, models) | PASS, 55 s with cached downloads |
| Engine starts with `friend start`, clients are told | log shows "Voice is ready"; browser WebSocket `status.voiceAvailable` is true | PASS |
| Real round trip | Piper speaks a question, the gateway transcribes it, the agent answers, the reply is spoken and transcribes back to the agent's words | PASS (automated, `voice/real.test.ts`) |
| Live route | recording posted from the browser: 200 with the real engine in about 0.8 s; 401 without a login | PASS |
| Browser support | MediaRecorder with webm/opus, getUserMedia on localhost, WAV from the engine decodes | PASS |
| Sidecar cleanup | engine exits when the app is killed | PASS |

## Sandbox (free-form pages) check

Results 2026-10-08:

| Check | How | Result |
|---|---|---|
| Frame attributes | `sandbox` is exactly `allow-scripts`; no `allow-same-origin`; `referrerpolicy=no-referrer`; `allow=""`; page in `srcdoc` | PASS (`objects/sandbox.test.tsx`) |
| Policy | `default-src 'none'`, inline script/style, `data:`/`blob:` images, no form action or base; policy precedes agent content; agent text cannot rewrite it | PASS |
| Size and type | non-text or over 100,000 characters refused on show and update, in words the model can read | PASS (`stage.sandbox.test.ts`) |
| Real Chrome | demo scene: animated canvas renders; self-test: network blocked, parent app blocked, storage blocked | PASS |

## Tasks and heartbeat check

Results 2026-10-08:

| Check | How | Result |
|---|---|---|
| Store | to-dos, timed reminders, past/NaN times refused, repeat needs a time, caps, order, done/reschedule/remove, due selection, missed slots skipped | PASS (`tasks.test.ts`) |
| Tools | `task.add/list/done/remove` without approval cards; ISO times need an offset; local current time in the owner prompt only | PASS (`agent/tasks.test.ts`) |
| Heartbeat | fires once; waits for a screen; waits while the agent is busy; a failing notification is retried; timer starts once and stops | PASS (`heartbeat.test.ts`) |
| In the running app | alert + stage card + spoken line + audit; held until a screen connects; no model turn is ever started | PASS (`heartbeat.app.test.ts`) |

Try it live: "remind me in 1 minute to stretch" and wait up to 15 seconds after the minute is up.

## Memory check

Results 2026-10-08:

| Check | How | Result |
|---|---|---|
| Store | add, tidy whitespace, duplicate (any case), 500-char and 200-note caps, search (all words, `%`/`_` literal, limit 10), forget, clear | PASS (`memory.test.ts`) |
| Agent | remember/search/forget tools without an approval card; a note saved mid-turn is in the next prompt; newest 20 only; notes flagged as data; injection-looking note stays on one line inside the block; guests never get notes | PASS (`agent/memory.test.ts`) |
| CLI | `friend memory list/forget/clear`; clear needs the PIN | PASS (`agent-cli/src/memory.test.ts`) |

Try it live with a real model: say "remember that my sister is Priya", start a new conversation, ask "who is my sister?".

## Phase 2b (camera) check

Results 2026-10-08:

| Check | How | Result |
|---|---|---|
| Round trip | scripted vision model calls `camera.snap`; the owner approves; a JPEG is uploaded; the next model call carries the image block | PASS (`camera.route.test.ts`) |
| Picture is never kept | database messages and audit log searched for the picture's bytes; only the stub and a byte count are there | PASS |
| Failure paths | browser denial reasons, timeout, late/duplicate/non-JPEG/oversize uploads, rate limit, no session, emergency lock, second tab | PASS |
| Policy | no standing rule can skip the card; "Always allow" is neither shown nor honored; a model without vision is refused before any card; guests cannot call it | PASS |
| Providers | Claude image block after the tool results; Ollama `images` on a following user message only when `ollama.vision` is true | PASS (`provider/images.test.ts`) |
| Browser | controller releases the camera on success, failure, cancel (even while the camera is still opening) and dispose; switch off answers 'off' without opening it; indicator only while open | PASS (jsdom) |
| Production build | `pnpm build` | PASS |

Not verified by a human: a real webcam (the dev machine's camera was deliberately not switched on during testing) and a real vision model. Try it: `friend start`, open the page, press Esc and set Camera: on, then ask "what am I holding?".

## Phase 5b (speaker verification) check

Results 2026-10-08:

| Check | How | Result |
|---|---|---|
| Voiceprint from the real model | Piper voices as people: same voice across phrases scores above 0.75, different voices below 0.72 | PASS (`packages/voice/tests/test_real_speaker.py`) |
| Enroll, accept, reject, end to end | real sidecar behind the gateway: enroll `lessac` with three phrases and the PIN, then a new phrase from `lessac` runs as owner; `amy` and `ryan` never do and get a tool-less, history-less turn | PASS (`voice/real.speaker.test.ts`) |
| Challenge, guest, enrollment, lock, config | scripted speakers: right/wrong PIN, 3-try limit, cancel, replace, lock; guest isolation; PIN, consistency and rate limit for enrollment | PASS (`voice/trust.test.ts`, `challenge.test.ts`, `enrollment.test.ts`) |
| Client | store, ChallengeCard, EnrollmentFlow, owner menu entry | PASS (jsdom) |

Not verified by a human: enrolling with a real microphone and the thresholds with real room noise (Piper voices are cleaner than a real mic, so expect to adjust `voice.accept` / `voice.challenge`). Try it: `friend start`, press Esc, Enroll my voice.

Not verified by a human (5a): holding Space and speaking into a real microphone (the test browser has no microphone), hearing the reply through speakers, and the sphere reacting to the live level. Try it: `friend voice setup`, `friend start`, open the page, hold Space, speak.
