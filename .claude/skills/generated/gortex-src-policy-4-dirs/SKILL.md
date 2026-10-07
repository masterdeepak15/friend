---
name: gortex-src-policy-4-dirs
description: "Work in the src/policy +4 dirs area — 28 symbols across 6 files (68% cohesion)"
---

# src/policy +4 dirs

28 symbols | 6 files | 68% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/agent-cli/src/cli.test.ts`
- `packages/agent-cli/src/commands/setup.ts`
- `packages/server/src/auth.ts`
- `packages/server/src/policy/classify.ts`
- `packages/server/src/policy/rules.ts`

## Key Files

| File | Symbols |
|------|---------|
| `` | trim, shift |
| `packages/agent-cli/src/cli.test.ts` | ask |
| `packages/agent-cli/src/commands/setup.ts` | password, pin, e, db, workspace, ... |
| `packages/server/src/auth.ts` | input, ph, pinh, setupOwner |
| `packages/server/src/policy/classify.ts` | command, isSimpleCommand |
| `packages/server/src/policy/rules.ts` | cwd, cmd, matcherMatches, rest, m, ... |

## Connected Communities

- **src/commands +3 dirs** (4 cross-edges)
- **server/src +2 dirs** (3 cross-edges)
- **server/src +1 dirs · all** (1 cross-edges)
- **server/src · hashSecret** (1 cross-edges)
- **src/presence +1 dirs · PresenceCore** (1 cross-edges)
- **server/src +3 dirs** (1 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-12")
explore(operation:"context", task:"understand src/policy +4 dirs", format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
