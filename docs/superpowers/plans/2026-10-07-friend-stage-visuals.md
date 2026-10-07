# Friend Phase 2a "Stage Visuals" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add chart/gauge/timeline/graph objects, auto layout, exit animation, orb and ring presence styles, mood intensity and a demo script.

**Architecture:** Protocol enums and tool text grow first; the client gains pure geometry helpers, SVG renderers, an auto-grid and ghost lifecycle, and a presence factory; a demo script drives it all with a fake model.

**Tech Stack:** unchanged (TypeScript, React, Three.js, Vitest). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-friend-stage-visuals-design.md`

## Global Constraints

- No new network access and no new dependencies; charts are hand-written SVG.
- Agent-supplied strings render only as React text nodes.
- Object limits: chart 6 series × 120 points; timeline 30 items; graph 40 nodes, 80 edges; max 12 objects on stage (unchanged).
- Presence styles exactly `sphere | orb | ring`; default `sphere`. Touch targets stay ≥ 44 px; reduced-motion respected.
- Files written with backslashes or regexes use the Write/Edit tools, never shell heredocs.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Malformed props (strings for numbers, NaN, huge arrays, empty series) never throw or hang. (Task 3)
2. A graph with duplicate ids, self-edges or edges to unknown nodes renders without crashing. (Task 3)
3. Rapid show/hide of the same id does not leave a stuck ghost or duplicate keys. (Task 4)
4. Switching presence style repeatedly does not leak canvases or animation frames. (Task 5)

---

### Task 1: Protocol additions
**Files:** Modify `packages/protocol/src/stage.ts`, `packages/protocol/src/tools.ts`; Test `packages/protocol/src/stage.test.ts`
**Interfaces:** Produces `PresenceStyle` (zod enum + type), `Placement` accepting `"auto"`, `StageObject.type` with the four new types; `StageSnapshot.presence.style: PresenceStyle`.
- [ ] Write failing tests: `auto` placement parses; types chart/gauge/timeline/graph parse; `presence` command with style `ring` parses and `"hologram"` fails; snapshot with invalid style fails.
- [ ] Run, expect FAIL. Implement the enum/placement/type additions and update tool descriptions (types, props shapes, `auto`, styles) in `tools.ts`. Run, expect PASS.
- [ ] Commit `feat(protocol): new object types, auto placement, presence styles`.

### Task 2: Server stage and prompt
**Files:** Modify `packages/server/src/stage.ts`, `packages/server/src/agent/prompt.ts`; Test `stage.test.ts`, `agent/loop.test.ts`
**Interfaces:** Consumes `PresenceStyle`; `StageState` default presence style `"sphere"`.
- [ ] Failing tests: `stage.presence` with style `orb` updates snapshot; invalid style returns a tool error; prompt mentions `auto`, `chart`, `gauge`, `timeline`, `graph`, `orb`, `ring`.
- [ ] Implement type tightening and prompt section. Run all server tests, expect PASS. Commit `feat(server): validate presence styles, teach prompt the new stage vocabulary`.

### Task 3: Geometry helpers and new object renderers
**Files:** Create `packages/web/src/objects/geometry.ts`, `packages/web/src/objects/charts.tsx`; Modify `objects.tsx` (CATALOG), `styles.css`; Test `geometry.test.ts`, `charts.test.tsx`
**Interfaces:** Produces `niceScale(min,max,ticks): {min,max,ticks:number[]}`, `scaleLinear([d0,d1],[r0,r1]): (v:number)=>number`, `linePath(points:[number,number][]): string`, `arcPath(cx,cy,r,a0,a1): string`, `gaugeAngle(value,min,max): number` (clamped 0..240°), `circleLayout(n,w,h): {x,y}[]`; components `Chart`, `Gauge`, `Timeline`, `Graph` taking `{props: Record<string, unknown>}`.
- [ ] Failing geometry tests: niceScale(0,97,5) covers 0..100 with round ticks; scaleLinear maps endpoints; linePath has one M and n-1 L; arcPath sweeps; gaugeAngle clamps below min/above max; circleLayout returns n distinct points inside bounds, n=0 empty, n=1 centered.
- [ ] Failing component tests: chart renders one path per series and a legend for >1 series, bar kind renders rects; chart with NaN/strings/empty series renders the empty message; 500-point series is truncated to 120; gauge shows value, label, switches color class above 80/95%; timeline renders items in order and caps at 30; graph renders nodes/edges, skips unknown-node edges, tolerates duplicate ids and self-edges, caps 40 nodes; all four tolerate `props = {}`.
- [ ] Implement helpers then components (inline SVG, CSS variables, `viewBox`), register in `CATALOG`, add styles. Run, expect PASS. Commit `feat(web): chart, gauge, timeline and graph objects`.

### Task 4: Auto layout, ghosts and mood intensity
**Files:** Create `packages/web/src/stage/ghosts.ts`; Modify `Stage.tsx`, `placement.ts`, `styles.css`, `store.ts` (no change expected); Test `ghosts.test.ts`, extend `stage.test.tsx`
**Interfaces:** Produces `useGhosts(objects: StageObject[], ms: number): {object: StageObject, leaving: boolean}[]`; `placementToStyle("auto", …)` returns `{position:"relative"}`.
- [ ] Failing tests: auto objects render inside `.auto-grid` while a `center` object stays absolute; with fake timers a removed object appears with `leaving` then disappears after 350 ms; re-showing the same id during its exit cancels the ghost without duplicate keys; reduced motion removes immediately; `--intensity` style variable present on the stage root and the ambient layer uses it.
- [ ] Implement the hook, grid container and CSS (fade/shrink keyframes, grid with corner clearance). Commit `feat(web): auto layout, exit animation, mood intensity`.

### Task 5: Presence styles
**Files:** Create `packages/web/src/presence/ring.ts`, `orb.ts`, `factory.ts`; Modify `Presence.tsx`, `core.ts` (intensity), `Stage.tsx` (pass style, intensity); Test `presence.test.tsx`
**Interfaces:** Produces `ringBars(count, phase, amplitude, noise): number[]` (values 0..1), `createPresence(style: PresenceStyle, host, opts:{accent,reducedMotion}): PresenceHandle`, `class RingPresence`, `class OrbPresence`; `PresenceHandle.setIntensity(v:number)`.
- [ ] Failing tests: ringBars returns `count` values in 0..1, grows with amplitude, deterministic for equal inputs; factory returns a handle for each style in jsdom (no WebGL) without throwing and never returns undefined; unknown style falls back to sphere; `<Presence style>` change disposes the old handle (host holds exactly one canvas after 5 switches); intensity scales core brightness (`PresenceCore.setIntensity`).
- [ ] Implement ring (Canvas 2D), orb (WebGL fragment shader on a full-quad, 2D fallback), factory and Presence wiring. Commit `feat(web): orb and ring presence styles`.

### Task 6: Integration, demo and visual check
**Files:** Create `scripts/demo.ts`; Modify `package.json` (script `demo`), `README.md`, `scripts/smoke.md`; Test `packages/server/src/integration.test.ts` (extend)
- [ ] Failing integration test: scripted agent calls `stage.show` (chart, auto placement) and `stage.presence` style `ring`; a newly connected client's snapshot contains both.
- [ ] Implement `demo.ts` (temp data dir, throwaway owner, scripted FakeProvider cycling scenes, prints URL and credentials). Run `pnpm build && pnpm test`, expect all green.
- [ ] Start the demo, capture browser screenshots of every object type and presence style at desktop and phone widths, fix anything visibly broken, stop the demo. Commit `feat: demo script and docs for stage visuals`.

---

## Self-Review
- Spec coverage: criteria 1 → T3, 2 → T4, 3 → T1/T2/T5, 4 → T4/T5, 5 → T4, 6 → T6, 7 → all tasks and a full test run in T6.
- Types: `PresenceStyle`, `Placement`, `StageObject` defined in T1 and reused by name; `PresenceHandle` extended in T5 only.
