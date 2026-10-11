# Music host output through mpv (plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the PC that runs Friend play the music through its own speakers, with no browser open, chosen by a setting; the screen then becomes a remote control for it.

**Architecture:** The player's queue logic (today in the web package) moves to `@friend/protocol` so a server-side `HostPlayer` can run the same queue. `HostPlayer` plays the owner's folder tracks by driving `mpv` over its JSON IPC, and Spotify tracks on a Spotify Connect device through the Web API. `MusicHub` sends commands to the target named by the `music.output` setting (`screen` or `host`). A screen in host mode sends its button presses to the server and shows the host's state.

**Tech Stack:** TypeScript, Node `child_process` and `net` (named pipe on Windows, Unix socket elsewhere), zod, React, vitest. No new npm dependencies. `mpv` is installed by the owner (free: `winget install mpv`, `brew install mpv`, `apt install mpv`).

**Spec:** `docs/superpowers/specs/2026-10-11-music-sources-design.md` (section 4, Output targets). Builds on plan 1 (`2026-10-11-music-sources-spotify.md`, shipped in 0.1.31). SoundCloud is plan 3.

## Global Constraints

- Friend ships no audio decoder; the folder's tracks are played only by the owner's own `mpv`.
- `music.hostPlayer` is the path or name of one program (not a command line with arguments); Friend adds mpv's own flags. Default empty (host output off for the folder). A value with spaces, quotes, `|`, `;`, `&`, `<`, `>` or a leading `-` is refused.
- mpv is started with `--no-video --idle=yes --no-terminal --input-ipc-server=<private pipe or socket>`; files are loaded through the IPC with `loadfile <path> replace`, never as command-line arguments, so a file name can never act as an option.
- Only a file that `MusicLibrary.resolve(id)` returns (inside the chosen folder, checked just now) is ever given to mpv.
- Settings: `music.output: "screen" | "host"` (default `screen`), `music.hostPlayer: string` (default `""`), `music.spotifyDevice: string` (default `""`, max 100 characters). All PIN-protected, refused for the assistant like the other music settings.
- When the chosen output cannot play, nothing is silent: the assistant's reply and the screen say why, and the command falls back to the newest active screen only when `output` is `screen`; for `host` it does not fall back (no double sound).
- Friend stopping, restarting or crashing leaves no mpv process running.
- Retry limit: a track that fails ends playback with a reason after one failure for a service error, and skips to the next after a failure to open a local file (as the screen player does); no loops.

## Review Focus

- mpv missing, wrong program, or crashing mid-track → one plain sentence, playback stops, Friend keeps running.
- Orphaned mpv after Friend stops, restarts, or the setting changes → none left.
- A file name that looks like an option, a path outside the folder, or a symlink swapped in after listing → mpv never gets it.
- Two outputs at once (screen and host both playing) → never; switching `output` stops the one that is leaving.
- Spotify device not found, no Premium, or Spotify's API answering with errors → one plain sentence, no polling storm.

---

### Task 1: Share the queue logic

**Files:**
- Create: `packages/protocol/src/musicQueue.ts` (moved from `packages/web/src/music/playerCore.ts`), export from `packages/protocol/src/index.ts`
- Modify: `packages/web/src/music/playerCore.ts` (re-exports from `@friend/protocol`), `packages/web/src/music/*.ts(x)` imports stay working
- Test: `packages/protocol/src/musicQueue.test.ts` (moved from `packages/web/src/music/playerCore.test.ts`)

**Interfaces:**
- Produces, unchanged in behaviour and signatures: `Track`, `PlayerView`, `PlayerState`, `PlayerAction`, `MAX_QUEUE`, `initialPlayer`, `shuffled`, `playerReducer`.

- [ ] **Step 1:** Move the 23 existing `playerCore` tests to `packages/protocol/src/musicQueue.test.ts` with the import changed; run `cd packages/protocol && npx vitest run src/musicQueue.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 2:** Move the implementation to `musicQueue.ts`, export it from the protocol index, make `web/src/music/playerCore.ts` a one-line re-export, delete the old test file.
- [ ] **Step 3:** Run `pnpm --filter @friend/protocol build`, then `npx vitest run` in protocol and web and `npx tsc --noEmit` in both — Expected: PASS with the same test counts (23 moved, nothing lost).
- [ ] **Step 4:** Commit `refactor(music): the queue logic lives in the protocol package`.

### Task 2: Output settings

**Files:**
- Modify: `packages/server/src/config.ts` (`MusicConfig`, `DEFAULT_MUSIC`, `sanitizeMusic`), `packages/server/src/settings.ts` (zod, apply), `packages/web/src/settings/settingsApi.ts` (`MusicSettings`), `packages/web/src/settings/WidgetsTab.tsx`
- Test: `packages/server/src/music/settings.test.ts` (extend), `packages/web/src/settings/widgets.test.tsx` (extend)

**Interfaces:**
- Produces: `MusicConfig.output: "screen" | "host"`, `MusicConfig.hostPlayer: string`, `MusicConfig.spotifyDevice: string`; `programProblem(value: string): string | null` exported from `packages/protocol/src/hud.ts` (the rule in Global Constraints) and used by both zod and the Widgets tab.

- [ ] **Step 1: Write failing tests**: defaults (`screen`, `""`, `""`); sanitize drops an invalid `hostPlayer` to `""` and an unknown `output` to `screen`; saving `{ output: "host", hostPlayer: "mpv" }` with a PIN applies live; `programProblem` refuses `"mpv --x"`, `"-x"`, `"a;b"`, `"a|b"`, `'"mpv"'`, and accepts `mpv`, `C:\Program Files\mpv\mpv.exe`'s spaced path form only as a path without arguments (spaces allowed inside a path that exists is **not** accepted: say so in the sentence and tell the owner to use a short path or add mpv to PATH); the assistant's `refuseForAgent` still refuses `music`; the Widgets tab shows the three fields and the problem sentence.
- [ ] **Step 2:** Run the two files — Expected: FAIL.
- [ ] **Step 3:** Implement. `programProblem` accepts `^[A-Za-z0-9._:\\/~+-]{1,260}$` not starting with `-`.
- [ ] **Step 4:** Run server and web `npx tsc --noEmit` and the two test files — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): output, host player and Spotify device settings`.

### Task 3: The mpv driver

**Files:**
- Create: `packages/server/src/music/mpv.ts`, `packages/server/src/music/testing/fakeMpv.mjs` (a small Node script that speaks mpv's JSON IPC over the same pipe/socket and logs the commands it gets)
- Test: `packages/server/src/music/mpv.test.ts`

**Interfaces:**
- Produces: `class Mpv { constructor(d: { program: () => string; spawn?: typeof spawn; dataDir: string; clock?: () => number }); start(): Promise<{ ok: true } | { ok: false; error: string }>; load(path: string): Promise<void>; pause(on: boolean): Promise<void>; seek(seconds: number): Promise<void>; volume(percent: number): Promise<void>; mute(on: boolean): Promise<void>; stop(): Promise<void>; onEvent(fn: (e: { type: "time"; position: number; duration: number } | { type: "paused"; paused: boolean } | { type: "ended" } | { type: "failed"; reason: string } | { type: "exited" }) => void): () => void; dispose(): void }`. `start()` is idempotent, spawns with the Global Constraints flags and a pipe named from the data dir and the process id, connects, then observes `time-pos`, `duration`, `pause`, `eof-reached` (and the `end-file` event, whose `reason` is `eof` for a track that ended and `error` for one that failed to open).

- [ ] **Step 1: Write failing tests** against `fakeMpv.mjs`: `start()` spawns once and reports `{ok:true}`; a program that does not exist gives `{ok:false, error}` with "mpv" in one sentence (no stack, no path of the pipe); `load` sends `loadfile <path> replace` over the IPC and the file name never appears in the spawn arguments (use a name like `--vo=null evil.mp3`); events from the fake (time, pause, end-file eof, end-file error) become `onEvent` calls; mpv exiting becomes `exited` and the next call starts it again; `dispose()` kills the child and removes the socket file; `start()` twice runs one child.
- [ ] **Step 2:** Run `npx vitest run src/music/mpv.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `mpv.ts` (newline-delimited JSON over `net.connect`; request ids; a 5 s timeout per request that becomes a plain error; pipe path `\\.\pipe\friend-mpv-<pid>` on Windows and `<dataDir>/mpv-<pid>.sock` elsewhere).
- [ ] **Step 4:** Run the test — Expected: PASS. Also run it twice in a row (the pipe name must not collide).
- [ ] **Step 5:** Commit `feat(music): mpv driver over its JSON IPC`.

### Task 4: Spotify Connect control

**Files:**
- Modify: `packages/server/src/music/spotify.ts` (add playback methods), `packages/server/src/music/testing/fakeSpotify.ts` (devices and the player endpoints)
- Test: `packages/server/src/music/spotifyConnect.test.ts`

**Interfaces:**
- Consumes: `SpotifyHub.api` (private today: expose a narrow `playerCall(method, path, body?)` that keeps the host check and the 401-renew-once rule).
- Produces on `SpotifyHub`: `devices(): Promise<{ id: string; name: string; active: boolean }[]>`; `playOn(deviceName: string, trackIds: string[], positionMs?: number): Promise<{ ok: true } | { ok: false; error: string }>` (finds the device by name, case-insensitive, then `PUT /v1/me/player/play?device_id=`); `control(deviceId: string, c: { action: "pause" | "resume" | "next" | "previous" | "seek" | "volume"; ms?: number; percent?: number }): Promise<void>`; `playbackState(): Promise<{ playing: boolean; trackId: string | null; positionMs: number; durationMs: number; deviceName: string } | null>`.

- [ ] **Step 1: Write failing tests** with the extended fake: `devices()` lists; `playOn("Living room", [...])` plays on that device; a missing name gives `{ok:false}` with "Spotify device" and the names that were found, in one sentence; a free account gives the Premium sentence; 429/garbage give one sentence and no second call; `playbackState` maps the fields and returns null when nothing plays (204); no message contains a token.
- [ ] **Step 2:** Run the test — Expected: FAIL.
- [ ] **Step 3:** Implement the methods on `SpotifyHub`.
- [ ] **Step 4:** Run `spotify.test.ts` and `spotifyConnect.test.ts` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): control a Spotify Connect device`.

### Task 5: HostPlayer

**Files:**
- Create: `packages/server/src/music/host.ts`
- Test: `packages/server/src/music/host.test.ts`

**Interfaces:**
- Consumes: `playerReducer`, `initialPlayer`, `PlayerState`, `PlayerAction` (Task 1); `Mpv` (Task 3); `SpotifyHub.playOn/control/playbackState` (Task 4); `MusicLibrary.resolve(id)`; `commandToAction(c: MusicCommand): PlayerAction | null` **moved** from `web/src/music/useMusicPlayer.ts` to `packages/protocol/src/musicQueue.ts` in this task (web keeps importing it from there).
- Produces: `class HostPlayer { constructor(d: { library: Pick<MusicLibrary, "resolve" | "ready">; mpv: Pick<Mpv, "start" | "load" | "pause" | "seek" | "volume" | "mute" | "stop" | "onEvent" | "dispose">; spotify: Pick<SpotifyHub, "playOn" | "control" | "playbackState" | "status">; settings: () => { volume: number; shuffle: boolean; repeat: "off" | "all" | "one"; spotifyDevice: string; hostPlayer: string }; emit: (state: MusicState) => void; clock?: () => number }); command(c: MusicCommand): Promise<{ ok: boolean; text: string }>; state(): MusicState; available(): { ok: true } | { ok: false; reason: string }; stop(): Promise<void>; dispose(): void }`. State is reported through `emit` at most once a second while playing and at once on every change.

- [ ] **Step 1: Write failing tests** with a fake `Mpv` and fake Spotify: `play` of two folder tracks loads the first through `library.resolve` (a path the library refuses is skipped with one sentence); `next`/`previous`/`shuffle`/`repeat`/`remove`/`clear`/`seek`/`volume`/`mute` act on the queue and on mpv as the screen player does; an mpv `ended` event advances the queue; a `failed` event for a file skips to the next once; `exited` stops playback with a plain reason; a `spotify:` track goes to `playOn(spotifyDevice, …)` and, when `spotifyDevice` is empty, gives "Name the Spotify device to play on in Settings, Widgets." and plays nothing; mixed queues switch engines and pause the one that is leaving; Spotify playback state is polled every 2 s only while a Spotify track plays and the poll stops when it does not; when Spotify says the track ended the queue advances; `available()` explains missing `hostPlayer`; `dispose()` calls `mpv.dispose()` and clears timers; the emitted state passes `MusicState.parse` for folder and Spotify tracks.
- [ ] **Step 2:** Run `npx vitest run src/music/host.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `HostPlayer` on top of `playerReducer` (the same reducer the screen uses, so behaviour is identical).
- [ ] **Step 4:** Run the test and the protocol and web suites (the moved `commandToAction`) — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): the PC plays the music itself`.

### Task 6: Hub routing, wiring and shutdown

**Files:**
- Modify: `packages/server/src/music/hub.ts` (a `host?: HostPlayer` dependency; `target()` follows `output`), `packages/server/src/app.ts` (build `Mpv` and `HostPlayer`, stop them on app stop and when `music.output` or `music.hostPlayer` changes), `packages/server/src/agent/loop.ts` and `prompt.ts` (replies name where it plays)
- Test: `packages/server/src/music/hub.test.ts` (extend), `packages/server/src/music/host.routes.test.ts`

**Interfaces:**
- Consumes: `HostPlayer` (Task 5), `config.music.output`.
- Produces: `MusicHub` constructor dependency `host?: Pick<HostPlayer, "command" | "state" | "available">` and `output?: () => "screen" | "host"`. With `output() === "host"`: `play/control/queue` call `host.command`, `nowPlaying` reads `host.state()`, and if `available()` is `{ok:false}` the result is `{ ok: false, text: reason }` with nothing sent to any screen. With `screen` nothing changes.

- [ ] **Step 1: Write failing tests**: host output sends the command to the host and not to the screen; host unavailable gives the reason and no screen command; `output` changed to `screen` makes the next command go to the screen; the reply says "on this PC" for host and nothing extra for the screen; switching `output` stops the player that is leaving (a fake records `stop()`); `app.stop()` disposes the host player (no mpv process left: use the fake program); saving `music.hostPlayer` or `music.output` rebuilds the driver; the assistant still cannot change either.
- [ ] **Step 2:** Run the files — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the whole server suite and `npx tsc --noEmit` — Expected: PASS (name the known flaky `claude-code/provider.test.ts` timing test if it fails, and run it alone).
- [ ] **Step 5:** Commit `feat(music): commands go to the output the owner chose`.

### Task 7: The screen as a remote

**Files:**
- Modify: `packages/protocol/src/messages.ts` (`ServerMsg` `music.host` carrying `MusicState`; `ClientMsg` `music.remote` carrying `MusicCommand`; `ui` music view gains `output`), `packages/server/src/app.ts` (broadcast host state to every screen; accept `music.remote` from a signed-in screen), `packages/web/src/store.ts`, `packages/web/src/music/useMusicPlayer.ts`, `packages/web/src/music/MusicPlayer.tsx`
- Test: `packages/web/src/music/remote.test.tsx`, protocol message tests

**Interfaces:**
- Produces: when the `ui` message says `output: "host"`, `useMusicPlayer` runs in **remote mode**: it builds no audio engine and plays nothing; its `state` is the last `music.host` state; `dispatch(action)` turns into `send({ type: "music.remote", command })` through the inverse of `commandToAction` (`actionToCommand(a: PlayerAction): MusicCommand | null`, in the protocol package). The player shows "Playing on this PC" in the title area.

- [ ] **Step 1: Write failing tests**: in remote mode no `Audio` element is created and Spotify's script is never loaded; pressing Play/Next/Volume sends `music.remote` with the matching command; the title area shows the host's track and "on this PC"; a `play` of library tracks from the Library tab goes through `music.remote`; switching back to `screen` rebuilds the local player; an `actionToCommand`/`commandToAction` round trip for every action; the server ignores `music.remote` from a screen that is not signed in and when `output` is `screen`.
- [ ] **Step 2:** Run the files — Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run protocol, server and web suites and all three `tsc` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): the screen controls the PC's player`.

### Task 8: Settings screen, docs, release

**Files:**
- Modify: `packages/web/src/settings/WidgetsTab.tsx` (a short "Where the sound comes out" block: output, mpv program, Spotify device, with the install hint for mpv), `README.md`, create `docs/guides/host-output.md`, `packages/friend/package.json`

- [ ] **Step 1:** Write the guide (install mpv; set the program name or short path; pick host output; Spotify device: run any Spotify Connect player on the PC and put its name in Settings; what the errors mean) and the README lines.
- [ ] **Step 2:** Run `npx tsc --noEmit` and `npx vitest run` in protocol, server and web — Expected: no FAIL.
- [ ] **Step 3:** `pnpm build`, bump the patch version, `npm run bundle` (it must not print "web app is older than packages/web/src"), commit and push. Do **not** publish: the owner is asked first.
- [ ] **Step 4:** On the owner's request: `npm publish`, `friend upgrade`, `friend daemon restart`.
- [ ] **Step 5:** With mpv installed and the owner's go-ahead, in Chrome on the Friend tab: Settings → Widgets shows the new block; with `output` host and a music folder, "play something" starts sound from the PC and the screen shows "on this PC". The owner does any PIN step.
