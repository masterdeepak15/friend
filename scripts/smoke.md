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
