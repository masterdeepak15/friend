# Hands-free wake word ("Hey Maya") — design

Owner request: speak without touching the keyboard. Say "hey Maya", "hay Maya", "hello Maya" (Maya = the name the owner chose), then the request. Quality matters more than features. Decided with the owner: the browser page listens first (A); a background listener on the PC comes later (B).

## Decisions

- **Opt-in, per device, off by default.** A switch in the owner menu ("Hands-free: on/off") on each browser; remembered in that browser only. An always-open microphone is the owner's choice for that device, and the browser shows its microphone indicator while it is on.
- **The name is the assistant's own name**, chosen when the account was made (`auth.assistantName()`, already sent to the page). Nothing is hard-coded and there is no second setting. Change the name, and the wake word changes.
- **No new model, no new port, no download.** The existing Whisper listener decides. No separate wake-word engine.
- **Safety floors stay fixed.** A wake-triggered request goes through the same speaker check (owner / PIN challenge / guest) and the same agent rules as a held-key request. Waking is not trust.

## How it works

Browser (`Listener`): keeps the microphone open, watches loudness with an adaptive noise floor, and cuts the audio into utterances (speech starts when loudness stays above the floor for 250 ms; it ends after 800 ms of quiet; at most 8 s). A MediaRecorder is restarted every 2 s while nothing is being said, so the start of a phrase is never lost. It pauses while Friend is speaking, while a held-key recording runs, and while a reply is being transcribed.

Each utterance is posted to `/api/voice/utterance?wake=1`. Server (`voice/wake.ts`, pure; route in `app.ts`):

1. Transcribe as usual.
2. `matchWake(text, name)` → `{ matched, rest }`. The text must START with an optional greeting (hey, hay, hi, hello, hellow, hallo, ok, okay, yo; हे, हाय, हॅलो, हेलो, हैलो, ओके) followed by the name. Name matching tolerates one wrong letter when the name has 4 or more letters (for Maya: Maia, Maye, Mayaa; not Mia), and compares ignoring case and punctuation.
3. Not matched: return `{ text: "", wake: false }`. No turn, no speaker work, nothing broadcast, nothing logged beyond a counter. The audio is dropped.
4. Matched with a request after the name: run the request (`rest`) through the normal path (speaker check, turn). Return `{ text: rest, wake: true }`.
5. Matched with nothing after the name: return `{ text: "", wake: true }`. The browser plays a short chime and records the next utterance (up to 8 s of patience) and posts it to the normal route.

Rate limit: the existing 10 requests per 10 s window applies; the page keeps one check in flight and skips utterances shorter than 400 ms. A busy or rate-limited answer is ignored quietly; other failures show one alert per 30 s.

## Not in this version

- Wake in Hindi/Marathi script for the name (matched only if the recognizer writes the name in Latin letters).
- Background listener without a browser (B).
- Biasing the recognizer with the name (a prompt hint): add only if tests with the real model show misses.

## Tests

`matchWake`: greetings, misspellings, case, punctuation, name inside a sentence (no match), name alone, empty name. Server route: unmatched drops silently, matched runs the turn, bare wake returns `wake:true`, non-enrolled/enrolled flows unchanged, ordinary route unchanged. Segmenter, Listener (fake clock and recorder), HandsFree (fake listener) and the menu switch each have their own tests: speech starts and ends, noise floor adapts, short blips ignored, pauses while speaking, rotation.
