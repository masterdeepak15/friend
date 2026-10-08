# Friend Phase 2b "Camera" Design Spec

Date: 2026-10-08 · Status: approved by delegation (owner: "you have full right to take decision behalf of me")
Builds on Phase 5b. Gives the agent eyes, on the owner's terms.

## 1. Purpose

Let the owner say "what is this?" or "read this label" while holding something up to the browser's camera. The agent can ask for a single picture; the owner's browser takes it only if the owner has switched the camera on, and only after the owner approves that request. Nothing is watched continuously and nothing is kept.

### Success criteria
1. The camera is **off by default** and is switched on only by the owner, in the browser (owner menu → "Camera"). A switch in the page is the first gate: with it off, the browser never opens the camera and the agent is told so.
2. The agent gets pictures through one tool, `camera.snap`. Each call shows a client-drawn approval card ("Look through the camera") that the owner approves or denies. "Always allow" is not offered for the camera.
3. While the camera is open the client shows an indicator the agent cannot hide or restyle. The camera is opened for one frame and closed again; it is never left running.
4. A frame is sent to the model for that turn only. It is downscaled (longest side 1024 px, JPEG), never written to disk, never saved in the conversation history (history keeps the text "[camera picture, not kept]"), and never shown to guests.
5. If the active model cannot see images, the tool says so in words ("this model cannot look at pictures; use a vision model") instead of failing silently. Claude models can see. Ollama can see only with a vision model (`ollama.vision` set to true in the config, e.g. `llava` or `qwen2.5vl`).
6. Emergency lock, logout, and a closed page cancel any pending camera request and release the camera.

## 2. Scope
**In:** `camera.snap` tool, request/response over the existing WebSocket, client camera controller and indicator, owner switch, image support in the provider layer (Claude and Ollama), history stripping, tests, docs.
**Out:** continuous video, recording, face recognition or identification, motion detection, remote cameras (phones as cameras), saving or showing pictures on the stage, screenshots of the PC.

## 3. Protocol
- Server → client: `camera.request {id}`; `camera.cancel {id}`.
- Client → server over the WebSocket: `camera.denied {id, reason: "off" | "no-camera" | "permission" | "busy"}`.
- The picture itself is not sent over the WebSocket (its frame limit protects chat). It is uploaded with `POST /api/camera/frame/:id`, body `image/jpeg`.
- `status` gains nothing: whether the camera switch is on is a client fact, reported in the denial.

## 4. Server
- Tool `camera.snap` (gateway target, tier T2, args none). Flow: policy asks for approval (existing card, tool name shown as "Look through the camera"); on approval the gateway broadcasts `camera.request {id}` and waits up to 20 s for a frame or a denial. A frame arrives through the HTTP route (authenticated session, 2 MB cap, `image/jpeg` only, JPEG magic bytes checked, one per pending request id, rate limited).
- Result to the agent: text `"Picture taken."` plus an `image` content block attached to the same tool message. Denials become tool errors with plain reasons ("The owner has the camera switched off").
- `ContentBlock` gains `{type:"image", mime, data}`. Providers: **Claude** maps it into the user turn after the tool results (image source base64). **Ollama** puts the base64 in the message's `images` array when `ollama.vision` is true; otherwise the tool refuses before asking the owner (so there is no pointless approval). `FakeProvider` records blocks.
- History: `saveMessage` replaces image blocks with a text stub before storing; the in-memory turn keeps the real image so the model can answer. `repairDangling` and loading never see image data.
- Only owner turns have tools, so guests can never reach the camera. A pending request is cleared on lock, on the turn being cancelled, and on timeout; a late frame for an unknown or finished id is ignored (and audited).
- Audit: `camera.requested`, `camera.approved`/`denied`, `camera.frame` (size only, no pixels).

## 5. Client
- `CameraController`: `snap(): Promise<Blob>` opens `getUserMedia({video:{width:{ideal:1280}}})`, waits for the first good frame (about 300 ms of warm-up so exposure settles), draws it to a canvas scaled to 1024 px, encodes JPEG at 0.8, stops every track, and resolves. Errors map to the denial reasons above.
- Owner switch (menu entry "Camera: off/on") stored in memory only (it resets on reload, on purpose). When off, `camera.request` is answered at once with `denied: "off"`.
- `CameraIndicator`: client-owned overlay badge ("Camera on") with a live preview thumbnail while the stream is open, above the stage (z-index like the mic indicator), not controllable by stage objects.
- Reaction to `camera.cancel`/lock: stop the tracks immediately.
- The frame is uploaded with `POST /api/camera/frame/:id` (`image/jpeg` body).

## 6. Safety notes
- Two gates (switch and per-use approval) plus the always-visible indicator; the model cannot trigger the camera by itself or hide that it is on.
- Pictures are untrusted input: text in a picture is data, not instructions. The system prompt gets one line saying so.
- The picture goes to the model provider (Claude) when Claude is the provider, so the approval card says "the picture will be sent to the AI model". With Ollama it stays on the PC.

## 7. Tests
Server: tool flow (approve → frame → image block), denial reasons, timeout, cancel on lock, wrong/unknown id, bad JPEG, oversize, rate limit, vision-less Ollama refusal before approval, history stripping, guest cannot call, Claude/Ollama request mapping. Web: controller (fake getUserMedia/canvas: tracks stopped on success and failure, scaling), switch off → denied, indicator shown only while open, cancel releases the camera. Integration: scripted model calls `camera.snap`; a fake client answers.

## 8. Risks
- Browsers need HTTPS or localhost for the camera; the docs say so (same as the microphone).
- A vision-capable local model is large; Claude is the practical vision path until a vision model is pulled.
