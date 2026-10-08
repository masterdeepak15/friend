# Friend Phase 5b "Speaker Verification" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Checkbox steps.

**Goal:** Only the owner's voice commands Friend; other voices become guests; borderline voices need the PIN.

**Architecture:** sherpa-onnx WeSpeaker embeddings in the Python sidecar; encrypted voiceprint and trust decision in the gateway; challenge/enrollment UIs drawn by the client.

**Spec:** `docs/superpowers/specs/2026-10-08-friend-speaker-verification-design.md`

## Global Constraints
Voiceprint encrypted at rest and local only; PIN required to enroll-commit, replace or delete; thresholds accept 0.72 / challenge 0.58 (configurable, accept > challenge); guest turns have no tools, no owner history, nothing persisted; challenge/enrollment UI is client-owned; write files with Write/Edit tools; typecheck with `rtk err pnpm typecheck`; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus
1. A guest or challenged utterance never reaches tools or owner history. 2. Challenge confirmation cannot be forged by the agent, replayed, brute-forced, or survive lock. 3. Enrollment cannot be completed or replaced without the PIN, and a stranger's samples cannot be mixed in. 4. Voiceprint never appears in logs, status, audit or responses.

---

### Task 1: Sidecar embedder and endpoints
Files: `packages/voice/friend_voice/{speaker,engines,models,server}.py`, `pyproject.toml` (sherpa-onnx), tests `test_speaker.py`.
- [ ] Failing tests: fake embedder deterministic per name and ~1 for same name; `/embed` returns 256-or-N floats and `seconds`; too-short body → 400; `/stt?embed=1` returns `embedding`; real model: lessac phrases score ≥ 0.8 with each other and < 0.6 against amy; silence → "not enough speech".
- [ ] Implement, download model with SHA-256 check in `models.py`; commit.

### Task 2: Voice service and voiceprint store
Files: `server/src/voice/{service,voiceprint,crypto}.ts`, migration, tests.
- [ ] Failing tests: cosine/centroid math, encryption round trip, wrong key fails, key file created once, enroll/score/clear, centroid not in plaintext in the DB, thresholds validation, `decideTrust` table; HttpVoiceService embed + `embed=1` parsing; FakeVoice speakers.
- [ ] Implement; commit.

### Task 3: Guest agent mode and protocol
Files: `agent/{loop,prompt}.ts`, `protocol/messages.ts`, tests.
- [ ] Failing tests: guest turn gets no history, persists nothing, no tools, prompt contains the guest rules; protocol accepts `voice.challenge`, `voice.heard.trust`, `status.voiceEnrolled`, `voice.confirm`, `voice.cancel`.
- [ ] Implement; commit.

### Task 4: Trust flow, challenge, enrollment endpoints
Files: `app.ts`, `gateway.ts`, `voice/challenge.ts`, `voice/enrollment.ts`, tests.
- [ ] Failing tests per spec §4 (owner/guest/challenge/unenrolled; confirm right/wrong PIN/limit/cancel/expiry/lock; enrollment flow, PIN, consistency, rate limit, delete).
- [ ] Implement; commit.

### Task 5: Web
Files: store, `overlay/ChallengeCard.tsx`, `voice/EnrollmentFlow.tsx`, owner menu, App wiring, tests.
- [ ] Failing tests; implement; commit.

### Task 6: CLI, real end-to-end, docs
- [ ] `friend voice status/forget`; real test with Piper voices; README/smoke notes; merge.
