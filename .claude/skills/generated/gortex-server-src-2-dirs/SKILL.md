---
name: gortex-server-src-2-dirs
description: "Work in the server/src +2 dirs area — 120 symbols across 9 files (76% cohesion)"
---

# server/src +2 dirs

120 symbols | 9 files | 76% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/server/src/agent/loop.ts`
- `packages/server/src/app.ts`
- `packages/server/src/audit.ts`
- `packages/server/src/auth.ts`
- `packages/server/src/gateway.hosts.test.ts`
- `packages/server/src/gateway.test.ts`
- `packages/server/src/gateway.ts`
- `packages/server/src/integration.test.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | toLowerCase, indexOf, toUpperCase, split |
| `packages/server/src/agent/loop.ts` | isBusy |
| `packages/server/src/app.ts` | _session, c, gateway.onClientMessage, statusMsg, broadcast, ... |
| `packages/server/src/audit.ts` | log, detail, actor, kind |
| `packages/server/src/auth.ts` | r, limiter, Auth, code, createPairCode, ... |
| `packages/server/src/gateway.hosts.test.ts` | gw.onClientMessage |
| `packages/server/src/gateway.test.ts` | loginCookie, post, headers, path, body, ... |
| `packages/server/src/gateway.ts` | clientIp, handleDevice, m, config, clientIp, ... |
| `packages/server/src/integration.test.ts` | send, m |

## Entry Points

- `packages/server/src/app.ts::gateway.onClientMessage@77`
- `packages/server/src/gateway.ts::handleClient`
- `packages/server/src/gateway.ts::express-handler@91`
- `packages/server/src/gateway.ts::createGateway`
- `packages/server/src/gateway.ts::express-handler@109`

## Connected Communities

- **server/src +4 dirs · attach** (11 cross-edges)
- **src/objects +11 dirs** (7 cross-edges)
- **src/policy +4 dirs** (6 cross-edges)
- **server/src · begin** (4 cross-edges)
- **. +3 dirs** (4 cross-edges)
- **server/src · close** (4 cross-edges)
- **server/src +3 dirs** (4 cross-edges)
- **. +1 dirs · mergeGhosts** (2 cross-edges)
- **server/src +5 dirs** (2 cross-edges)
- **src/auth +3 dirs** (2 cross-edges)
- **server/src +1 dirs · respond** (2 cross-edges)
- **src/commands +3 dirs** (1 cross-edges)
- **src/policy · add** (1 cross-edges)
- **server/src · StageState** (1 cross-edges)
- **. +2 dirs · verifySecret** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-38")
explore(operation:"context", task:"understand server/src +2 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/server/src/app.ts::gateway.onClientMessage@77"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
