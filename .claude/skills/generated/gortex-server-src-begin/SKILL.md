---
name: gortex-server-src-begin
description: "Work in the server/src · begin area — 32 symbols across 3 files (76% cohesion)"
---

# server/src · begin

32 symbols | 3 files | 76% cohesion

## When to Use

Use this skill when working on files in:
- `packages/server/src/auth.ts`
- `packages/server/src/gateway.ts`
- `packages/server/src/ratelimit.ts`

## Key Files

| File | Symbols |
|------|---------|
| `packages/server/src/auth.ts` | l, clock, audit, keys, constructor, ... |
| `packages/server/src/gateway.ts` | route handler |
| `packages/server/src/ratelimit.ts` | entries, key, reset, e, constructor, ... |

## Entry Points

- `packages/server/src/gateway.ts::express-handler@138`

## Connected Communities

- **server/src +4 dirs · attach** (4 cross-edges)
- **web/src +1 dirs** (1 cross-edges)
- **server/src +2 dirs** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-50")
explore(operation:"context", task:"understand server/src · begin", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/server/src/gateway.ts::express-handler@138"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
