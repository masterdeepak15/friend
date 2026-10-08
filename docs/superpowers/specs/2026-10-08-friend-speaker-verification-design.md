# Friend Phase 5b "Speaker Verification" Design Spec

Date: 2026-10-08 · Status: approved by delegation ("do it"; owner delegated decisions)
Builds on Phase 5a (voice I/O). Also adds the Ollama provider used for testing without an API key (separate, already merged on this branch).

## 1. Purpose

Only the owner's voice may command Friend by speech. A voice that does not match is treated as an untrusted guest: it gets a polite, protective reply but no tools and no private context. A borderline match asks the owner for the PIN.

Voice is a convenience signal, not a lock: recordings or cloned voices can fool any speaker model. So a voice match never replaces the PIN for risky actions, and a borderline match needs the PIN.

### Success criteria
1. The sidecar turns speech into a 256-number voiceprint locally (WeSpeaker ResNet34 via sherpa-onnx, no GPU, no torch).
2. The owner enrolls from the browser (owner menu → "Enroll my voice"): 5 prompted phrases, a PIN to commit. Re-enrolling or deleting needs the PIN.
3. Each spoken utterance is scored against the voiceprint (cosine similarity) and sorted: **owner** (≥ 0.72), **challenge** (≥ 0.58), **guest** (below).
4. Owner: runs as before. Challenge: nothing runs; a client-drawn card asks "Was that you?" with the heard words and a PIN pad; the right PIN runs the utterance as the owner; wrong PIN, cancel or 60 s timeout discards it. Guest: the agent answers with no tools and no history of the owner's conversation, the answer is spoken, and the owner's screens get a warning.
5. If no voiceprint is enrolled, behavior is as in 5a (all voice is owner) and the UI says voice recognition is not set up.
6. The voiceprint is stored encrypted at rest (AES-256-GCM, key in a private file) and never leaves the PC; it can be deleted.
7. Emergency lock clears any pending challenge and any enrollment in progress.
8. A real test with different Piper voices as "speakers": the enrolled voice is accepted as owner for new phrases; other voices are never accepted as owner.

## 2. Scope
**In:** embedding in the sidecar, voiceprint store, scoring and trust decision, enrollment endpoints and UI, challenge flow, guest agent mode, status/protocol additions, CLI status/forget, tests.
**Out:** liveness/anti-spoofing detection, continuous learning of the voiceprint, multiple owners, wake word.

## 3. Sidecar
- New `speaker.py`: `SpeakerEmbedder` (lazy, one lock) using `sherpa_onnx.SpeakerEmbeddingExtractor` with `wespeaker_en_voxceleb_resnet34.onnx` (25 MB, downloaded to `<models>/speaker`, SHA-256 checked). Input: the same bounded decoder (`decode_audio`, 90 s cap). Output: L2-normalized 256-float vector plus voiced seconds. Rejects audio with less than 1.2 s of speech (ValueError → 400 "not enough speech").
- `POST /embed` returns `{embedding, seconds}`. `POST /stt?embed=1` returns the transcript plus `embedding` (or `embedding: null` when too short), decoding once.
- `FakeEngines` gets a deterministic fake embedder: a body `VOICE:<name>:<anything>` yields a vector derived from `<name>` with a little noise, so tests can script speakers.

## 4. Server
- `VoiceService.transcribe(audio, mime, language?, {embed?}) → {text, language, embedding?}` and `embed(audio, mime) → number[]`; `FakeVoice` scripts speakers.
- Migration `002`: table `voiceprint(id=1, centroid_enc BLOB, samples INTEGER, model TEXT, created_at)`. `Voiceprint` class: `enroll(embeddings)`, `score(embedding)`, `exists()`, `clear()`; cosine math; encryption with a 32-byte key in `<dataDir>/voice.key` (mode 0600, created on first use).
- Trust decision `decideTrust(score, {accept, challenge})` with config `voice.accept` (0.72) and `voice.challenge` (0.58), validated 0..1 and accept > challenge.
- Utterance route (existing) flow: busy → 409; transcribe with embedding; lock check; empty transcript → nothing; if enrolled: score → trust; not enrolled: `unverified` (treated as owner).
  - `owner`/`unverified`: `voice.heard {text, trust}` then owner turn, reply spoken.
  - `guest`: `voice.heard {text, trust:"guest"}`, owner clients get an `alert` (warn), guest turn (see §5), reply spoken.
  - `challenge`: store one pending `{id, text, ip, expires}` (replacing any older one), broadcast `voice.challenge {id, text}`; no turn yet.
- `voice.confirm {id, pin}` (WebSocket, owner session): PIN checked with the existing rate-limited `verifyPin`; right PIN → pending utterance runs as owner and is spoken; wrong PIN → alert, stays pending (limit 3 attempts then discard). `voice.cancel {id}` and expiry discard it.
- Enrollment (owner session, rate limited, audio ≤ 4 MB): `GET /api/voice/enroll` (state), `POST /api/voice/enroll/sample` (adds one embedding to the in-memory session, max 8, replies with how many and a quality note), `POST /api/voice/enroll/finish {pin}` (needs ≥ 3 samples that agree with each other, mean cosine to the centroid ≥ 0.55; PIN required; replaces an existing print), `POST /api/voice/enroll/cancel`, `DELETE /api/voice/enroll {pin}`.
- `status` gains `voiceEnrolled`.

## 5. Guest agent mode
`Agent.runTurn(text, {trust:"guest"})`: no tools (already), **no stored history in the context and nothing persisted**, and a system prompt section: the speaker is unverified, never reveal private information, files, memories, credentials or the owner's schedule, do not take actions, be polite and brief, and say the owner will be told. Owner conversation history is untouched.

## 6. Client
- Store: `challenge: {id, text} | null`, `voice.enrolled`; `voice.heard` with `trust: "guest"` shows the caption as "Guest: …".
- Client-owned overlay: `ChallengeCard` (heard text, PinPad, Confirm/Dismiss; z-index above the stage). `EnrollmentFlow` overlay opened from the owner menu: five prompts, record each by holding the button or Space, upload, progress and quality hints, then PIN to finish; also Delete.
- A one-time toast "Voice recognition is not set up" when voice is available and no voiceprint exists.

## 7. CLI
`friend voice status` shows enrolled/not; `friend voice forget` deletes the voiceprint after asking for the PIN. `friend config set voice.accept 0.75` / `voice.challenge 0.6`.

## 8. Tests
Python: embedder with the fake and real model (same voice vs other voices, too-short audio, endpoints). Node: cosine/centroid, encryption round trip and wrong key, trust decision table, enrollment flow incl. PIN and consistency check, challenge confirm/cancel/expiry/attempt limit/lock, guest isolation (no history, nothing persisted, no tools), unenrolled behavior. Web: store, ChallengeCard, EnrollmentFlow. Real: Piper voices as speakers end to end.

## 9. Risks
- Real microphones vary more than TTS: thresholds are configurable and a challenge costs only a PIN.
- Spoofing by recordings or voice cloning is not detected; the PIN for risky actions remains the real guard (stated in the docs).
