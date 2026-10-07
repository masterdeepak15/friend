---
name: gortex-voice-friend-voice-2-dirs
description: "Work in the voice/friend_voice +2 dirs area — 55 symbols across 5 files (95% cohesion)"
---

# voice/friend_voice +2 dirs

55 symbols | 5 files | 95% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/voice/friend_voice/__main__.py`
- `packages/voice/friend_voice/engines.py`
- `packages/voice/friend_voice/server.py`
- `packages/voice/tests/test_server.py`

## Key Files

| File | Symbols |
|------|---------|
| `` | Thread, Request, encode, ThreadingHTTPServer, subprocess, ... |
| `packages/voice/friend_voice/__main__.py` | main |
| `packages/voice/friend_voice/engines.py` | FakeSTT, transcribe, FakeEngines, language, audio |
| `packages/voice/friend_voice/server.py` | make_server, token, max_body, port, engines |
| `packages/voice/tests/test_server.py` | base, test_stt_rejects_an_empty_body_with_400, base, base, base, ... |

## Entry Points

- `packages/voice/friend_voice/__main__.py::main`
- `packages/voice/tests/test_server.py::test_the_cli_prints_a_ready_line_with_the_port`
- `packages/voice/friend_voice/engines.py::FakeSTT.transcribe`
- `packages/voice/tests/test_server.py::base`
- `packages/voice/tests/test_server.py::test_tts_rejects_missing_text_and_invalid_json`

## Connected Communities

- **. +2 dirs · load_engines** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-60")
explore(operation:"context", task:"understand voice/friend_voice +2 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/voice/friend_voice/__main__.py::main"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
