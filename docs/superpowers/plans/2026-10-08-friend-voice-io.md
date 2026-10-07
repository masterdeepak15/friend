# Friend Phase 5a "Voice I/O" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Push-to-talk speech in, spoken replies out, all local, with the presence following real audio.

**Architecture:** Python HTTP sidecar (faster-whisper, Piper) managed by the gateway; utterances POSTed to the gateway; replies synthesized per sentence and streamed as WebSocket audio chunks; the web client records, plays and animates.

**Tech Stack:** Python 3.14 venv (faster-whisper, piper-tts, pytest), Node/TypeScript, React, MediaRecorder, Web Audio.

**Spec:** `docs/superpowers/specs/2026-10-08-friend-voice-io-design.md`

## Global Constraints

- Audio never leaves the PC; never stored; sidecar binds 127.0.0.1 with a shared secret; utterance body ≤ 4 MB; audio chunks ≤ 48 KB.
- No always-on listening; recording only while the key or press is held; the mic indicator is client-owned.
- Voice is optional; its absence must not change any existing behavior or test.
- Files with backslashes/regexes are written with Write/Edit tools; typecheck with `pnpm typecheck` and read its output for `error TS`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A transcript that is empty, whitespace, or only punctuation starts no agent turn. (Task 5)
2. Unauthenticated, oversized, or rapid-fire utterance requests are rejected before any transcription work. (Task 5)
3. Barge-in during synthesis: no audio chunk is sent after `audio.stop`. (Task 5)
4. Releasing the key twice, key repeat while held, and focus loss while recording never leave the mic open. (Task 7)

---

### Task 1: Python sidecar skeleton (stub engines)
**Files:** Create `packages/voice/pyproject.toml`, `friend_voice/{__init__,__main__,server,engines}.py`, `tests/test_server.py`
**Interfaces:** `Engines` protocol: `stt.transcribe(audio: bytes, language: str|None) -> {text, language, duration}`, `tts.synthesize(text: str, voice: str|None) -> bytes (WAV)`. `make_server(engines, token, port=0, max_body=4_000_000) -> (server, port)`. CLI `python -m friend_voice --token T [--port N] [--fake]` prints `{"ready":true,"port":N}`.
- [ ] Create the venv (`python -m venv .voice-dev`) and install pytest only; write failing tests with stub engines: `/health` 200 with token and 401 without; `/stt` returns the stub text for a body and rejects an oversize body with 413; `/tts` returns `audio/wav` starting `RIFF`; unknown path 404; engine exception → 500 JSON error; ready line printed by `--fake`.
- [ ] Run, expect FAIL; implement; run, expect PASS. Commit `feat(voice): sidecar HTTP server with stub engines`.

### Task 2: Real engines and setup pipeline
**Files:** Create `friend_voice/{stt,tts,models}.py`, `scripts/voice-setup.mjs` (Node installer used by the CLI), `tests/test_real_roundtrip.py`
**Interfaces:** `WhisperSTT(model, models_dir)`, `PiperTTS(voice, models_dir)`; installer steps: create venv, `pip install faster-whisper piper-tts`, download Piper voice, warm the Whisper model.
- [ ] Install real deps into the venv; write the round-trip test (Piper says "The quick brown fox jumps over the lazy dog"; Whisper transcribes; word overlap ≥ 80%); run, expect FAIL until engines exist.
- [ ] Implement engines (lazy load, int8 CPU, `language=None` auto-detect, WAV encode); run, expect PASS. Commit `feat(voice): faster-whisper and piper engines`.

### Task 3: Protocol additions
**Files:** Modify `packages/protocol/src/messages.ts`; Test `protocol.test.ts`
**Interfaces:** ServerMsg `voice.heard{text}`, `audio.chunk{id,seq,last,mime,data}`, `audio.stop{}`; `status.voiceAvailable?: boolean`; ClientMsg `voice.interrupt`.
- [ ] Failing tests (valid/invalid shapes, chunk `seq` non-negative int, `data` string); implement; commit `feat(protocol): voice messages`.

### Task 4: VoiceService client and sidecar manager
**Files:** Create `packages/server/src/voice/{service.ts,sidecar.ts}`; Test `voice/voice.test.ts`
**Interfaces:** `interface VoiceService {available():boolean; transcribe(audio:Buffer, mime:string, language?:string|null):Promise<{text:string;language:string}>; synthesize(text:string, voice?:string):Promise<Buffer>}`; `HttpVoiceService(baseUrl, token)`; `SidecarProcess.start(opts:{python:string; token:string; dataDir:string; fake?:boolean}):Promise<{port:number; stop():Promise<void>}>`; `FakeVoice` for tests.
- [ ] Failing tests against an in-process fake sidecar HTTP server: auth header sent, transcribe/synthesize map responses, non-200 → rejects with message, timeout; sidecar manager reads the ready line, restarts once after a crash, stops cleanly, reports unavailable when python is missing.
- [ ] Implement; commit `feat(server): voice service client and sidecar manager`.

### Task 5: Gateway route, Speaker and wiring
**Files:** Create `packages/server/src/voice/speaker.ts`; Modify `gateway.ts`, `app.ts`, `config.ts`; Test `voice/speaker.test.ts`, `gateway.test.ts`, `integration.test.ts`
**Interfaces:** `speechText(markdown:string):string`, `splitSentences(text:string):string[]`, `chunkBase64(buf:Buffer, size:number):string[]`, `class Speaker { speak(text:string, emit:(m:ServerMsg)=>void):Promise<void>; interrupt():void }`; gateway dep `onVoiceUtterance(session, audio:Buffer, mime:string, ip:string):Promise<{text:string}>`; config `voice`.
- [ ] Failing tests: markdown/emoji/code stripped, sentences split incl. abbreviations and no-punctuation text, chunk sizes ≤ 48 KB and reassemble; speak sends ordered chunks per sentence, `interrupt()` stops further chunks and emits `audio.stop`; route: 401 without cookie, 413 oversize, 429 rapid-fire, 503 when unavailable, `{text:""}` and no turn for empty/punctuation-only transcript, valid utterance runs a turn and returns the text; integration: scripted provider + FakeVoice → `voice.heard`, captions, `audio.chunk`s, `voice.interrupt` → `audio.stop` and no later chunks; status carries `voiceAvailable`.
- [ ] Implement; commit `feat(server): voice utterance route and spoken replies`.

### Task 6: Web recorder, player, store
**Files:** Create `packages/web/src/voice/{recorder.ts,player.ts}`; Modify `store.ts`; Test `voice/voice.test.ts`, `store.test.ts`
**Interfaces:** `class Recorder {static supported():boolean; start():Promise<void>; stop():Promise<Blob>; cancel():void; level():number}`; `class AudioPlayer {enqueue(chunk:AudioChunkMsg):void; stop():void; level():number; onChange(cb):()=>void; playing():boolean}`; store `voice: {mode, level, available}` and local actions `voice.mode`, `voice.level`; `status.voiceAvailable` handled.
- [ ] Failing tests with fake `navigator.mediaDevices`, `MediaRecorder`, `AudioContext`: permission denied rejects with a readable error; stop returns the recorded blob and releases the tracks; cancel releases tracks; level reads the analyser; player reassembles chunks by id, plays clips in order, `stop()` clears the queue and the current source, level 0 when idle; store reduces voice actions and `voiceAvailable`.
- [ ] Implement; commit `feat(web): microphone recorder, audio player, voice store`.

### Task 7: Push-to-talk hook, presence override, mic indicator
**Files:** Create `packages/web/src/voice/{useVoice.ts,MicIndicator.tsx}`; Modify `Stage.tsx`, `App.tsx`, `Overlay.tsx`, `styles.css`; Test `voice/useVoice.test.tsx`, `stage.test.tsx`, `overlay.test.tsx`
**Interfaces:** `useVoice({send, dispatch, state}): {pressStart():void; pressEnd():void; supported:boolean}`; Space keydown/up and long-press on the presence call them.
- [ ] Failing tests: Space down starts recording once (key repeat ignored), up stops and POSTs the blob to `/api/voice/utterance` with the right content type; Space while an input is focused or the command bar is open does nothing; window blur or double release closes the mic; pressing while speaking sends `voice.interrupt` and stops playback; POST failure raises an alert; unavailable voice raises a notice; Stage shows `listening` and mic level as amplitude while recording and `speaking` while playing; `MicIndicator` visible exactly while mode is listening/transcribing and above the stage objects.
- [ ] Implement; commit `feat(web): push-to-talk voice, presence follows audio, mic indicator`.

### Task 8: CLI, docs, real end-to-end
**Files:** Create `packages/agent-cli/src/commands/voice.ts`; Modify `cli.ts`, `start.ts`, `README.md`, `scripts/smoke.md`; Test `cli.test.ts`, `packages/server/src/voice/real.test.ts`
**Interfaces:** `friend voice setup|status`; `friend start` launches the sidecar when installed and enabled.
- [ ] Failing tests: `voice status` reports not installed/installed without printing secrets; `config set` accepts `voice.enabled`, `voice.sttModel`, `voice.ttsVoice`; `start` does not fail when voice is not installed; real test (skipped with a clear message only when the venv is missing): through the real sidecar and gateway, TTS → utterance route → transcript matches.
- [ ] Run `friend voice setup` for real on this machine, run the real round trip, check the TTS path and mic indicator in a browser, write results to `scripts/smoke.md`. Commit `feat: friend voice setup/status, docs, real round trip`.
