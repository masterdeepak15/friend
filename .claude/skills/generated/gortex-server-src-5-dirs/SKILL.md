---
name: gortex-server-src-5-dirs
description: "Work in the server/src +5 dirs area — 77 symbols across 15 files (76% cohesion)"
---

# server/src +5 dirs

77 symbols | 15 files | 76% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/agent-cli/src/cli.test.ts`
- `packages/server/src/agent/history.ts`
- `packages/server/src/agent/loop.test.ts`
- `packages/server/src/agent/loop.ts`
- `packages/server/src/agent/prompt.ts`
- `packages/server/src/audit.ts`
- `packages/server/src/db.ts`
- `packages/server/src/devices.test.ts`
- `packages/server/src/devices.ts`
- `packages/server/src/gateway.test.ts`
- `packages/server/src/integration.test.ts`
- `packages/server/src/provider/types.ts`
- `packages/server/src/stage.test.ts`
- `packages/server/src/tools/registry.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | findIndex, some, reverse, push |
| `packages/agent-cli/src/cli.test.ts` | f.out, s |
| `packages/server/src/agent/history.ts` | repairDangling, start, loadHistory, msgs, rows, ... |
| `packages/server/src/agent/loop.test.ts` | m, emit |
| `packages/server/src/agent/loop.ts` | userFacing, text, tools, ctx, cmd, ... |
| `packages/server/src/agent/prompt.ts` | assistantName, stageSummary, buildSystemPrompt |
| `packages/server/src/audit.ts` | clock, constructor, db |
| `packages/server/src/db.ts` | Db |
| `packages/server/src/devices.test.ts` | n, startNode, t |
| `packages/server/src/devices.ts` | hasOnline |
| `packages/server/src/gateway.test.ts` | gw.onClientMessage, conn, _s, msg |
| `packages/server/src/integration.test.ts` | ws, msgs, closeCode, Client, cookie, ... |
| `packages/server/src/provider/types.ts` | Msg, ContentBlock |
| `packages/server/src/stage.test.ts` | emit, m |
| `packages/server/src/tools/registry.ts` | toolSpecs, ToolSpec |

## Connected Communities

- **src/objects +11 dirs** (5 cross-edges)
- **server/src +4 dirs · attach** (4 cross-edges)
- **server/src +2 dirs** (3 cross-edges)
- **server/src +3 dirs** (2 cross-edges)
- **src/commands +3 dirs** (1 cross-edges)
- **server/src · executeTool** (1 cross-edges)
- **server/src · StageState** (1 cross-edges)
- **server/src +1 dirs · all** (1 cross-edges)
- **server/src +1 dirs · respond** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-22")
explore(operation:"context", task:"understand server/src +5 dirs", format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
