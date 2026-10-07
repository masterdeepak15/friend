# Friend Phase 5a "Voice I/O" Design Spec

Date: 2026-10-08 · Status: approved by delegation (owner: "do which you think better", decide and ask only on important matters)
Builds on Phase 1 (core) and Phase 2a (stage visuals). Speaker verification is **5b** (separate spec); wake word and hands-free listening are later.

## 1. Purpose

Let the owner talk to Friend and hear it answer, entirely on the owner's PC. The owner holds a key (or long-presses the presence) to talk. Audio is transcribed locally, the agent answers as usual, and the reply is spoken aloud while the presence animation follows the real audio level.

### Success criteria
1. A Python sidecar provides local speech-to-text (faster-whisper) and text-to-speech (Piper); no audio or text leaves the PC for these steps.
2. Holding Space (when no text field is focused), or long-pressing the presence, records the microphone; releasing sends the utterance; the heard text appears as a caption and the agent replies.
3. Replies to voice utterances are spoken: the first sentence starts playing before the whole reply is synthesized.
4. While recording, the presence is in `listening` and its amplitude follows the microphone level; while speaking, it is in `speaking` and follows the playback level. Pressing talk while Friend speaks interrupts it (barge-in).
5. A client-drawn microphone indicator is always visible while the mic is open (Layer 4; the agent cannot hide it).
6. Voice is optional: without the sidecar everything works as before and the UI says voice is unavailable instead of failing.
7. `friend voice setup` installs the sidecar into a project-private virtual environment and downloads the models; `friend voice status` reports state.
8. A real round trip (Piper speaks a sentence, Whisper transcribes it) passes in an automated test on this machine.
9. Phase 1 and 2a tests keep passing.

## 2. Scope

**In:** sidecar, process management, gateway utterance route, reply speaking, client recorder/player/hook, presence override, mic indicator, CLI setup/status, config.
**Out:** speaker verification and guest mode (5b), wake word, always-listening/VAD, interruption by voice activity, camera (2b), streaming partial transcripts.

## 3. Architecture

```
Browser mic --MediaRecorder--> POST /api/voice/utterance --> Gateway --> sidecar /stt (faster-whisper)
                                                              |  text -> agent turn (trust owner)
Gateway <-- reply text --> Speaker (sentences) --> sidecar /tts (Piper) --> audio.chunk over WebSocket --> browser player --> presence
```

- **Sidecar** (`packages/voice`, Python): stdlib `ThreadingHTTPServer` on `127.0.0.1`, ephemeral port, shared secret in the `Authorization` header, prints a JSON `{"ready":true,"port":N}` line when ready. Endpoints: `GET /health`, `POST /stt` (any audio container, decoded by PyAV; returns `{text, language, duration}`), `POST /tts` (JSON `{text, voice?}`, returns `audio/wav`). Models load lazily and stay cached. Engines sit behind small interfaces so tests use stubs.
- **VoiceService** (server): interface `{ available(): boolean; transcribe(audio: Buffer, mime: string): Promise<{text, language}>; synthesize(text: string): Promise<Buffer> }` with an HTTP client implementation and a `SidecarProcess` manager that spawns the venv's Python, reads the ready line, restarts once on crash, stops on shutdown.
- **Gateway:** `POST /api/voice/utterance` (session cookie required, raw audio body up to 4 MB, per-IP rate limit, Host/Origin rules as elsewhere). It transcribes, broadcasts `voice.heard {text}`, runs the turn as the owner, and returns `{text}`. Empty transcripts return `{text: ""}` and start no turn. If voice is unavailable it returns 503.
- **Speaker** (server): after a voice-originated turn, takes the full reply text, strips markdown, splits into sentences, synthesizes each in order, and broadcasts `audio.chunk {id, seq, last, mime, data(base64)}` (chunks ≤ 48 KB) so playback starts after the first sentence. `voice.interrupt` from a client cancels the job and broadcasts `audio.stop`.
- **Protocol additions:** ServerMsg `voice.heard`, `audio.chunk`, `audio.stop`; `status` gains optional `voiceAvailable`; ClientMsg `voice.interrupt`.
- **Client:** `Recorder` (getUserMedia + MediaRecorder + AnalyserNode), `AudioPlayer` (reassemble chunks, decodeAudioData, queue, AnalyserNode level), `useVoice` hook (push-to-talk state machine, barge-in), store `voice` slice (`mode: idle|listening|transcribing|speaking`, `level`, `available`), Stage presence override (state and amplitude from `voice` when active), `MicIndicator` in the client-owned overlay.

## 4. Security and privacy

- Utterances are accepted only from an authenticated owner session; rate limited; size limited; the audio is never stored (kept in memory for the request) and never sent anywhere except the local sidecar.
- Sidecar binds loopback only, requires the shared secret, and refuses oversize bodies.
- The mic indicator is client-owned and cannot be suppressed by stage commands. Recording only happens while the key/press is held; there is no always-on listening in this slice.
- Until 5b, any person who can press the key on a logged-in browser speaks as the owner; the PIN still guards risky actions. This is stated in the docs.

## 5. Configuration

`config.voice = { enabled: boolean (default true), sttModel: string (default "base"), ttsVoice: string (default "en_US-lessac-medium"), language: string | null (default null = auto-detect) }`. Models live under `~/.friend/voice/models`; the virtual environment under `~/.friend/voice/venv`.

## 6. Errors

- Sidecar not installed/not running: `voiceAvailable=false`; the UI shows a short notice when the user tries to talk; typed chat is unaffected.
- STT failure or timeout (60 s): the route returns 502, the client shows an alert, no turn runs.
- TTS failure on a sentence: that sentence is skipped with an audit entry; the captions already show the text.
- Microphone permission denied or unsupported browser (including non-HTTPS origins other than localhost): an alert explains it.

## 7. Testing

- Python (pytest, stub engines): HTTP contract, auth, size limits, error mapping, ready line.
- Node: VoiceService against an in-process fake sidecar; sidecar manager with a fake child; gateway utterance route (auth, size, rate limit, 503, empty transcript); Speaker (markdown stripping, sentence split, chunking, interruption); integration with scripted provider and fake voice: utterance → captions → audio chunks → interrupt → audio.stop.
- Web: recorder and player with fakes (permission denied, chunk reassembly, queue order, stop, level); push-to-talk state machine (Space down/up, typing guard, barge-in); presence override; mic indicator always shown while recording.
- Real round trip (needs the installed sidecar): Piper synthesizes a known sentence, Whisper transcribes it, the text matches within a small word-error margin.
- Manual: the owner holds Space and speaks (cannot be automated here; the TTS path and indicator can be checked in a browser).

## 8. Risks

- Python 3.14 is new; chosen packages resolve to binary wheels here (checked). If a model download fails, `friend voice setup` reports it and leaves voice disabled.
- CPU-only transcription latency: the `base` model is fast enough (a few seconds per utterance); larger models are configurable.
- Browser support differs (Safari records mp4/aac): the sidecar decodes containers with PyAV, so the container does not matter.
