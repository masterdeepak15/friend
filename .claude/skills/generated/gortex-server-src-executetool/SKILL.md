---
name: gortex-server-src-executetool
description: "Work in the server/src · executeTool area — 28 symbols across 2 files (70% cohesion)"
---

# server/src · executeTool

28 symbols | 2 files | 70% cohesion

## When to Use

Use this skill when working on files in:
- `packages/server/src/agent/loop.ts`
- `packages/server/src/policy/classify.ts`

## Key Files

| File | Symbols |
|------|---------|
| `packages/server/src/agent/loop.ts` | d, fail, TurnCtx, device, ToolCall, ... |
| `packages/server/src/policy/classify.ts` | p, classifyShell, command, patterns |

## Entry Points

- `packages/server/src/agent/loop.ts::Agent.executeTool`

## Connected Communities

- **server/src +2 dirs** (3 cross-edges)
- **server/src +4 dirs · runStageTool** (2 cross-edges)
- **src/objects +11 dirs** (2 cross-edges)
- **server/src +4 dirs · attach** (2 cross-edges)
- **server/src +3 dirs** (1 cross-edges)
- **server/src +1 dirs · respond** (1 cross-edges)
- **src/policy · matches** (1 cross-edges)
- **. +1 dirs · lexicalInsideRoots** (1 cross-edges)
- **. +3 dirs** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-23")
explore(operation:"context", task:"understand server/src · executeTool", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/server/src/agent/loop.ts::Agent.executeTool"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
