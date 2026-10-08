---
name: gortex-src-objects-2-dirs
description: "Work in the src/objects +2 dirs area — 28 symbols across 5 files (81% cohesion)"
---

# src/objects +2 dirs

28 symbols | 5 files | 81% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/web/src/objects/charts.test.tsx`
- `packages/web/src/objects/charts.tsx`
- `packages/web/src/objects/geometry.ts`
- `packages/web/src/presence/sphere.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | querySelector, isFinite |
| `packages/web/src/objects/charts.test.tsx` | cls, v |
| `packages/web/src/objects/charts.tsx` | frac, max, v, value, min, ... |
| `packages/web/src/objects/geometry.ts` | arcPath, r, pt, a1, cy, ... |
| `packages/web/src/presence/sphere.ts` | h, side, w, pointScale |

## Entry Points

- `packages/web/src/objects/charts.tsx::Gauge`

## Connected Communities

- **src/objects +1 dirs** (3 cross-edges)
- **src/objects · niceScale** (1 cross-edges)
- **src/policy +4 dirs** (1 cross-edges)
- **src/tools +2 dirs** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-64")
explore(operation:"context", task:"understand src/objects +2 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/web/src/objects/charts.tsx::Gauge"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
