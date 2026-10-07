---
name: gortex-src-provider-3-dirs
description: "Work in the src/provider +3 dirs area — 47 symbols across 7 files (82% cohesion)"
---

# src/provider +3 dirs

47 symbols | 7 files | 82% cohesion

## When to Use

Use this skill when working on files in:
- `packages/server/src/agent/loop.test.ts`
- `packages/server/src/app.ts`
- `packages/server/src/integration.test.ts`
- `packages/server/src/provider/fake.ts`
- `packages/server/src/provider/provider.test.ts`
- `packages/server/src/provider/types.ts`
- `scripts/demo.ts`

## Key Files

| File | Symbols |
|------|---------|
| `packages/server/src/agent/loop.test.ts` | text, name, args, call, slow.stream, ... |
| `packages/server/src/app.ts` | MissingKeyProvider, AppOptions, stream, id, _req |
| `packages/server/src/integration.test.ts` | name, call, t, args, text, ... |
| `packages/server/src/provider/fake.ts` | i, e, req, events, stream, ... |
| `packages/server/src/provider/provider.test.ts` | collect, out, it, e |
| `packages/server/src/provider/types.ts` | ToolSpec, ProviderEvent, StreamRequest, Provider |
| `scripts/demo.ts` | c, stream, scene, last, turns, ... |

## Entry Points

- `scripts/demo.ts::DemoProvider.stream`

## Connected Communities

- **server/src +5 dirs** (4 cross-edges)
- **server/src +1 dirs · respond** (1 cross-edges)
- **src/objects +11 dirs** (1 cross-edges)
- **server/src +4 dirs · attach** (1 cross-edges)
- **server/src +2 dirs** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-49")
explore(operation:"context", task:"understand src/provider +3 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"scripts/demo.ts::DemoProvider.stream"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
