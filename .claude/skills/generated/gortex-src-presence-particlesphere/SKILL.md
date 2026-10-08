---
name: gortex-src-presence-particlesphere
description: "Work in the src/presence · ParticleSphere area — 26 symbols across 1 files (81% cohesion)"
---

# src/presence · ParticleSphere

26 symbols | 1 files | 81% cohesion

## When to Use

Use this skill when working on files in:
- `packages/web/src/presence/sphere.ts`

## Key Files

| File | Symbols |
|------|---------|
| `packages/web/src/presence/sphere.ts` | material, core, last, count, i, ... |

## Entry Points

- `packages/web/src/presence/sphere.ts::ParticleSphere.constructor`

## Connected Communities

- **. +1 dirs · ensureHook** (2 cross-edges)
- **src/presence · Fallback2D** (1 cross-edges)
- **src/objects +2 dirs** (1 cross-edges)
- **src/presence +1 dirs · RingPresence** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-77")
explore(operation:"context", task:"understand src/presence · ParticleSphere", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/web/src/presence/sphere.ts::ParticleSphere.constructor"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
