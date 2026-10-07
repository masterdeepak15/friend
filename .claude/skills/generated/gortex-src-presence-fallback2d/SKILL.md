---
name: gortex-src-presence-fallback2d
description: "Work in the src/presence · Fallback2D area — 31 symbols across 2 files (88% cohesion)"
---

# src/presence · Fallback2D

31 symbols | 2 files | 88% cohesion

## When to Use

Use this skill when working on files in:
- `packages/web/src/presence/fallback2d.ts`
- `packages/web/src/presence/sphere.ts`

## Key Files

| File | Symbols |
|------|---------|
| `packages/web/src/presence/fallback2d.ts` | disposed, last, host, constructor, canvas, ... |
| `packages/web/src/presence/sphere.ts` | r, theta, fibonacciSphere, y, golden, ... |

## Entry Points

- `packages/web/src/presence/fallback2d.ts::Fallback2D.constructor`

## Connected Communities

- **src/presence +1 dirs · RingPresence** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-71")
explore(operation:"context", task:"understand src/presence · Fallback2D", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/web/src/presence/fallback2d.ts::Fallback2D.constructor"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
