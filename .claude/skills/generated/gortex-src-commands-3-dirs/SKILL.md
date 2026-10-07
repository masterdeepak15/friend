---
name: gortex-src-commands-3-dirs
description: "Work in the src/commands +3 dirs area — 98 symbols across 10 files (84% cohesion)"
---

# src/commands +3 dirs

98 symbols | 10 files | 84% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/agent-cli/src/cli.test.ts`
- `packages/agent-cli/src/cli.ts`
- `packages/agent-cli/src/commands/config.ts`
- `packages/agent-cli/src/commands/node.ts`
- `packages/agent-cli/src/commands/pair.ts`
- `packages/agent-cli/src/commands/rules.ts`
- `packages/agent-cli/src/commands/start.ts`
- `packages/agent-cli/src/commands/status.ts`
- `packages/server/src/audit.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | replace |
| `packages/agent-cli/src/cli.test.ts` | token, err, prepare, policy, db, ... |
| `packages/agent-cli/src/cli.ts` | cmd, run, e, io, argv, ... |
| `packages/agent-cli/src/commands/config.ts` | io, args, configCommand, parse, cfg, ... |
| `packages/agent-cli/src/commands/node.ts` | code, url, name, i, res, ... |
| `packages/agent-cli/src/commands/pair.ts` | db, code, pairCommand, url, io, ... |
| `packages/agent-cli/src/commands/rules.ts` | db, args, id, policy, rulesCommand, ... |
| `packages/agent-cli/src/commands/start.ts` | token, opts, io, app, stored, ... |
| `packages/agent-cli/src/commands/status.ts` | cfg, db, io, auth, statusCommand, ... |
| `packages/server/src/audit.ts` | Audit |

## Entry Points

- `packages/agent-cli/src/commands/node.ts::nodeCommand`
- `packages/agent-cli/src/commands/rules.ts::rulesCommand`
- `packages/agent-cli/src/commands/status.ts::statusCommand`

## Connected Communities

- **server/src +2 dirs** (8 cross-edges)
- **server/src +5 dirs** (3 cross-edges)
- **src/policy +4 dirs** (3 cross-edges)
- **src/objects +11 dirs** (2 cross-edges)
- **server/src +3 dirs** (2 cross-edges)
- **server/src +1 dirs · all** (2 cross-edges)
- **agent-cli/src · startDeviceNode** (1 cross-edges)
- **src/presence +1 dirs · PresenceCore** (1 cross-edges)
- **src/policy · matches** (1 cross-edges)
- **src/policy · removeRule** (1 cross-edges)
- **server/src +4 dirs · runStageTool** (1 cross-edges)
- **server/src +4 dirs · attach** (1 cross-edges)
- **src/auth +3 dirs** (1 cross-edges)
- **src/policy · add** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-13")
explore(operation:"context", task:"understand src/commands +3 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/agent-cli/src/commands/node.ts::nodeCommand"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
