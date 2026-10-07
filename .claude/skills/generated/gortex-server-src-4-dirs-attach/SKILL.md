---
name: gortex-server-src-4-dirs-attach
description: "Work in the server/src +4 dirs · attach area — 72 symbols across 12 files (64% cohesion)"
---

# server/src +4 dirs · attach

72 symbols | 12 files | 64% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/server/src/agent/loop.test.ts`
- `packages/server/src/app.ts`
- `packages/server/src/auth.ts`
- `packages/server/src/db.ts`
- `packages/server/src/devices.test.ts`
- `packages/server/src/devices.ts`
- `packages/server/src/gateway.test.ts`
- `packages/server/src/provider/claude.ts`
- `packages/server/src/stage.ts`
- `packages/web/src/presence/orb.ts`
- `packages/web/src/presence/sphere.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | set, get, resolve, parse, delete, ... |
| `packages/server/src/agent/loop.test.ts` | assistantName |
| `packages/server/src/app.ts` | device, gateway.onDeviceConnect, ws, agent.assistantName |
| `packages/server/src/auth.ts` | r, assistantName |
| `packages/server/src/db.ts` | dataDir, applied, m, db, openDb |
| `packages/server/src/devices.test.ts` | audit, ws, db, device, makeGateway, ... |
| `packages/server/src/devices.ts` | id, opts, device, targetName, sockets, ... |
| `packages/server/src/gateway.test.ts` | headers, open, path |
| `packages/server/src/provider/claude.ts` | events, outputTokens, e, stream, req, ... |
| `packages/server/src/stage.ts` | isNew, expiresAt, apply, cmd, ApplyResult, ... |
| `packages/web/src/presence/orb.ts` | setAccent, color |
| `packages/web/src/presence/sphere.ts` | color, setAccent |

## Entry Points

- `packages/server/src/provider/claude.ts::ClaudeProvider.stream`
- `packages/server/src/devices.ts::DeviceHub.attach`

## Connected Communities

- **src/objects +11 dirs** (5 cross-edges)
- **server/src +2 dirs** (3 cross-edges)
- **. +1 dirs · mergeGhosts** (2 cross-edges)
- **server/src +3 dirs** (2 cross-edges)
- **. +1 dirs · replaceAll** (2 cross-edges)
- **server/src +5 dirs** (2 cross-edges)
- **server/src +1 dirs · respond** (2 cross-edges)
- **server/src +1 dirs · all** (1 cross-edges)
- **server/src · close** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-34")
explore(operation:"context", task:"understand server/src +4 dirs · attach", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/server/src/provider/claude.ts::ClaudeProvider.stream"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
