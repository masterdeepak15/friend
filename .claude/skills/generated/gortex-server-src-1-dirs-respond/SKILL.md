---
name: gortex-server-src-1-dirs-respond
description: "Work in the server/src +1 dirs · respond area — 35 symbols across 3 files (68% cohesion)"
---

# server/src +1 dirs · respond

35 symbols | 3 files | 68% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/server/src/approvals.test.ts`
- `packages/server/src/approvals.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | entries, values, info |
| `packages/server/src/approvals.test.ts` | m, emit |
| `packages/server/src/approvals.ts` | outcome, request, args, pending, id, ... |

## Connected Communities

- **server/src +4 dirs · attach** (5 cross-edges)
- **server/src +2 dirs** (2 cross-edges)
- **src/policy +4 dirs** (2 cross-edges)
- **. +1 dirs · mergeGhosts** (1 cross-edges)
- **. +2 dirs · verifySecret** (1 cross-edges)
- **server/src +5 dirs** (1 cross-edges)
- **src/presence +1 dirs · PresenceCore** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-27")
explore(operation:"context", task:"understand server/src +1 dirs · respond", format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
