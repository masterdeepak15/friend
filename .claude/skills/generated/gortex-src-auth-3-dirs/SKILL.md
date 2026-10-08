---
name: gortex-src-auth-3-dirs
description: "Work in the src/auth +3 dirs area — 40 symbols across 6 files (85% cohesion)"
---

# src/auth +3 dirs

40 symbols | 6 files | 85% cohesion

## When to Use

Use this skill when working on files in:
- ``
- `packages/agent-cli/src/bin.ts`
- `packages/web/src/App.tsx`
- `packages/web/src/auth/LoginScreen.tsx`
- `packages/web/src/auth/SetupScreen.tsx`
- `packages/web/src/auth/auth.test.tsx`

## Key Files

| File | Symbols |
|------|---------|
| `` | then, error, catch |
| `packages/agent-cli/src/bin.ts` | s, io.err |
| `packages/web/src/App.tsx` | phase, setPhase, App |
| `packages/web/src/auth/LoginScreen.tsx` | e, setError, setPassword, error, password, ... |
| `packages/web/src/auth/SetupScreen.tsx` | pin, res, error, setPin, submit, ... |
| `packages/web/src/auth/auth.test.tsx` | jsonResponse, body, json, status |

## Entry Points

- `packages/web/src/auth/LoginScreen.tsx::submit`
- `packages/web/src/App.tsx::App`
- `packages/web/src/auth/SetupScreen.tsx::submit`
- `packages/web/src/auth/LoginScreen.tsx::LoginScreen`
- `packages/web/src/auth/SetupScreen.tsx::SetupScreen`

## Connected Communities

- **server/src +3 dirs** (2 cross-edges)

## How to Explore

```
analyze(operation:"communities", id:"community-61")
explore(operation:"context", task:"understand src/auth +3 dirs", format:"gcx")
relations(operation:"usages", target:{symbol:"packages/web/src/auth/LoginScreen.tsx::submit"}, format:"gcx")
```

_`format: "gcx"` returns the [GCX1 compact wire format](../../docs/wire-format.md) — round-trippable, ~27% fewer tokens than JSON. Drop it for JSON output; agents using `@gortex/wire` or the Go `github.com/gortexhq/gcx-go` package decode either._
