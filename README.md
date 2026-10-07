# Friend

A self-hosted personal AI assistant. It runs on your PC, talks to you from any screen over WebSocket, uses tools on your machine with risk-based approvals, and controls a full-screen sci-fi "stage" itself.

Phase 1: secure login, agent loop with Claude, CLI device node, approvals with PIN, and a minimal stage with a particle-sphere presence. Phase 2a: chart, gauge, timeline and graph objects, automatic layout, fade-out, orb and ring voice styles and mood intensity. Phase 5a: local voice. Hold Space and speak; Friend answers aloud. Voice, camera, memory, heartbeat, taskboard and the plugin store come in later phases. See `docs/superpowers/specs` and `docs/superpowers/plans`.

## Quick start (development)

```bash
pnpm install
pnpm build                 # builds the web client
pnpm friend setup          # password, PIN, assistant name, workspace folder, API key
pnpm friend start          # gateway + local device node, http://127.0.0.1:8787
```

Open the address in a browser, sign in, and press any key to talk. Press `Esc` (or long-press the top-left corner) for the owner menu: mute stage, log out, emergency lock.

Preview the whole look with no API key and no network: `pnpm build && pnpm demo`, then open the printed address. Each message you send shows the next scene (gauges and charts, a timeline, a graph, the orb and ring voice styles, a warm mood).

Other commands: `friend rules list|remove <id>`, `friend devices list|revoke <id>`, `friend status`, `friend config set <key> <value>`, `friend pair` (code to connect another PC), `friend node --url <ws-url> --code <code>`.

## Voice (local, optional)

```bash
pnpm friend voice setup     # one time: private Python environment + speech models (about 250 MB)
pnpm friend start           # starts the speech engine too
```

Hold **Space** (or long-press the screen) and speak; release to send. Friend answers in captions and aloud, and the sphere follows the real audio. Pressing Space while it talks interrupts it. Typed messages are answered silently.

- Everything runs on your PC: speech to text with faster-whisper, text to speech with Piper. Recordings are never stored or sent anywhere else.
- Needs Python 3.10 or newer. `friend voice status` shows the state; `friend config set voice.sttModel small` (or `voice.language hi`, `voice.ttsVoice <piper voice>`, `voice.enabled false`) changes it, then run `friend voice setup` again for new models.
- The browser needs microphone permission and a secure origin (localhost, or HTTPS through your domain).
- **Until speaker verification (next phase), anyone who can press Space on a logged-in browser speaks as you.** The PIN still guards risky actions.
- Python tests for the speech engine: `cd packages/voice && python -m venv .venv && .venv/Scripts/pip install -e .[dev] && .venv/Scripts/python -m pytest`.

## Safety model

- Reading is free, writing inside your workspace is free, shell commands ask first, destructive commands ask and need your PIN.
- Approval cards and the PIN pad are drawn by the client, never by the agent.
- Everything the agent does is written to the audit log.

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
