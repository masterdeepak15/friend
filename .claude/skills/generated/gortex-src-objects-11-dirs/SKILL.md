---
name: gortex-src-objects-11-dirs
description: "Work in the src/objects +11 dirs area — 116 symbols across 21 files (75% cohesion)"
---

# src/objects +11 dirs

116 symbols | 21 files | 75% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/agent-cli/src/bin.ts`
- `packages/agent-cli/src/commands/config.ts`
- `packages/agent-cli/src/tools/fs.ts`
- `packages/agent-cli/src/tools/shell.ts`
- `packages/server/src/agent/loop.test.ts`
- `packages/server/src/audit.ts`
- `packages/server/src/integration.test.ts`
- `packages/server/src/provider/claude.ts`
- `packages/web/src/objects/charts.test.tsx`
- `packages/web/src/objects/charts.tsx`
- `packages/web/src/objects/geometry.ts`
- `packages/web/src/overlay/AlertToast.tsx`
- `packages/web/src/overlay/Overlay.tsx`
- `packages/web/src/overlay/PinPad.tsx`
- `packages/web/src/socket.ts`
- `packages/web/src/stage/Stage.tsx`
- `packages/web/src/stage/ghosts.ts`
- `packages/web/src/stage/stage.test.tsx`
- `packages/web/src/store.ts`
- `scripts/demo.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | filter, flatMap, map, repeat, clear, ... |
| `packages/agent-cli/src/bin.ts` | c, ch, onData |
| `packages/agent-cli/src/commands/config.ts` | v, list |
| `packages/agent-cli/src/tools/fs.ts` | g, e, output, entries, truncated, ... |
| `packages/agent-cli/src/tools/shell.ts` | take, d, room, s |
| `packages/server/src/agent/loop.test.ts` | types |
| `packages/server/src/audit.ts` | redact, value |
| `packages/server/src/integration.test.ts` | of, t, captions, T |
| `packages/server/src/provider/claude.ts` | toAnthropicMessages, messages |
| `packages/web/src/objects/charts.test.tsx` | name, series, values |
| `packages/web/src/objects/charts.tsx` | labels, kind, labelStep, sx, hi, ... |
| `packages/web/src/objects/geometry.ts` | domain, d1, r0, scaleLinear, r1, ... |
| `packages/web/src/overlay/AlertToast.tsx` | Toast, AlertToast |
| `packages/web/src/overlay/Overlay.tsx` | OverlayProps |
| `packages/web/src/overlay/PinPad.tsx` | add, PinPad, add, d |
| `packages/web/src/socket.ts` | state |
| `packages/web/src/stage/Stage.tsx` | style, narrow, corner, fixed, setOpenRequest, ... |
| `packages/web/src/stage/ghosts.ts` | timers, useGhosts, ms, objects, list, ... |
| `packages/web/src/stage/stage.test.tsx` | withState, patch |
| `packages/web/src/store.ts` | LocalAction, _t, objects, approval, i, ... |
| `scripts/demo.ts` | shift, base, wave, amp |

## Entry Points

- `packages/web/src/objects/charts.tsx::Chart`
- `packages/web/src/stage/Stage.tsx::Stage`
- `packages/agent-cli/src/bin.ts::onData`
- `packages/web/src/overlay/PinPad.tsx::PinPad`
- `packages/agent-cli/src/commands/config.ts::list`

## Connected Communities

- **src/objects +1 dirs** (11 cross-edges)
- **server/src +4 dirs · attach** (4 cross-edges)
- **src/tools +2 dirs** (2 cross-edges)
- **server/src +1 dirs · respond** (2 cross-edges)
- **. +1 dirs · mergeGhosts** (2 cross-edges)
- **src/policy +4 dirs** (1 cross-edges)
- **server/src +2 dirs** (1 cross-edges)
- **. +2 dirs · verifySecret** (1 cross-edges)
- **src/objects +2 dirs** (1 cross-edges)
- **src/objects · niceScale** (1 cross-edges)
- **. +2 dirs · CommandBar** (1 cross-edges)
- **server/src +5 dirs** (1 cross-edges)
- **. +1 dirs · fsRead** (1 cross-edges)
- **. +1 dirs · replaceAll** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-63")
explore(operation:"context", task:"understand src/objects +11 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/web/src/objects/charts.tsx::Chart"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
