---
name: gortex-1-dirs-json
description: "Work in the . +1 dirs · _json area — 26 symbols across 2 files (96% cohesion)"
---

# . +1 dirs · _json

26 symbols | 2 files | 96% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/voice/friend_voice/server.py`

## Key Files

| File | Symbols |
|------|---------|
| `` | compare_digest, urllib.parse.urlparse, parse_qs, urllib.parse.parse_qs, hmac, ... |
| `packages/voice/friend_voice/server.py` | do_GET, log_message, _stt, body, query, ... |

## Entry Points

- `packages/voice/friend_voice/server.py::Handler.do_POST`
- `packages/voice/friend_voice/server.py::Handler.do_GET`

## Connected Communities

- **voice/friend_voice +2 dirs** (3 cross-edges)
- **. +2 dirs · transcribe** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-56")
explore(operation:"context", task:"understand . +1 dirs · _json", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/voice/friend_voice/server.py::Handler.do_POST"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
