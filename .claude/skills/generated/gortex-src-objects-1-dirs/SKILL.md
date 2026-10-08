---
name: gortex-src-objects-1-dirs
description: "Work in the src/objects +1 dirs area — 37 symbols across 3 files (71% cohesion)"
---

# src/objects +1 dirs

37 symbols | 3 files | 71% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/web/src/objects/charts.tsx`
- `packages/web/src/objects/geometry.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | isArray |
| `packages/web/src/objects/charts.tsx` | edges, Timeline, id, n, clip, ... |
| `packages/web/src/objects/geometry.ts` | r2, b, len, r1, a, ... |

## Entry Points

- `packages/web/src/objects/charts.tsx::Graph`
- `packages/web/src/objects/charts.tsx::Timeline`

## Connected Communities

- **src/objects +11 dirs** (8 cross-edges)
- **server/src +5 dirs** (2 cross-edges)
- **. +1 dirs · mergeGhosts** (2 cross-edges)
- **server/src +4 dirs · attach** (2 cross-edges)
- **src/tools +2 dirs** (1 cross-edges)
- **. +2 dirs · verifySecret** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-65")
explore(operation:"context", task:"understand src/objects +1 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/web/src/objects/charts.tsx::Graph"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
