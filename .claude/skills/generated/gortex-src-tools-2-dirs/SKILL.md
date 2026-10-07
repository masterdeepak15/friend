---
name: gortex-src-tools-2-dirs
description: "Work in the src/tools +2 dirs area — 28 symbols across 5 files (78% cohesion)"
---

# src/tools +2 dirs

28 symbols | 5 files | 78% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/agent-cli/src/tools/index.ts`
- `packages/agent-cli/src/tools/shell.ts`
- `packages/agent-cli/src/tools/system.ts`
- `packages/protocol/src/tools.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | toFixed |
| `packages/agent-cli/src/tools/index.ts` | ctx, a, ToolCtx, def, e, ... |
| `packages/agent-cli/src/tools/shell.ts` | child, r, ShellCtx, runCommand, cwdArg, ... |
| `packages/agent-cli/src/tools/system.ts` | ctx, systemInfo, processList, lines |
| `packages/protocol/src/tools.ts` | ToolResult |

## Connected Communities

- **. +1 dirs · fsRead** (2 cross-edges)
- **. +1 dirs · realish** (1 cross-edges)
- **server/src +4 dirs · runStageTool** (1 cross-edges)
- **src/objects +11 dirs** (1 cross-edges)
- **server/src +4 dirs · attach** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-19")
explore(operation:"context", task:"understand src/tools +2 dirs", format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
