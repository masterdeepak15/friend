---
name: gortex-server-src-createapp
description: "Work in the server/src · createApp area — 25 symbols across 3 files (68% cohesion)"
---

# server/src · createApp

25 symbols | 3 files | 68% cohesion

## When to Use

Use this skill when working on files in:
- `packages/server/src/app.ts`
- `packages/server/src/integration.test.ts`
- `packages/server/src/stage.ts`

## Key Files

| File | Symbols |
|------|---------|
| `packages/server/src/app.ts` | config, policy, stage, start, gateway, ... |
| `packages/server/src/integration.test.ts` | boot, script |
| `packages/server/src/stage.ts` | expire, gone, id, now, e |

## Connected Communities

- **server/src +2 dirs** (4 cross-edges)
- **server/src +4 dirs · attach** (3 cross-edges)
- **server/src +5 dirs** (1 cross-edges)
- **server/src · loadConfig** (1 cross-edges)
- **server/src · listen** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-39")
explore(operation:"context", task:"understand server/src · createApp", format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
