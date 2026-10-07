# Friend Phase 2a "Stage Visuals" Design Spec

Date: 2026-10-07 · Status: approved by delegation (owner told the assistant to decide and only ask on important matters)
Builds on: `2026-10-07-friend-core-design.md` (Phase 1, merged). Architecture reference: https://claude.ai/artifact/744TPuiCSuo3223qRJnNwd

## 1. Purpose

Make the agent-controlled screen feel like the sci-fi monitor the owner described: richer things the agent can draw, a choice of living voice shapes, automatic tidy layout, and smooth appear/disappear. No new permissions or network access are introduced; camera (2b) and free-form sandbox (2c) are separate specs.

### Success criteria
1. The agent can show `chart` (line, bar, area), `gauge`, `timeline` and `graph` objects, and they render correctly from valid props and degrade safely (nothing thrown, nothing broken) from malformed props.
2. `placement: "auto"` objects are arranged by the client in a responsive grid without the agent choosing coordinates; mixed with named/relative placements they do not overlap the presence corner on phones or desktops.
3. The agent can switch the presence between `sphere`, `orb` and `ring` at runtime with `stage.presence`; every style has idle, listening, thinking and speaking looks and reacts to amplitude. Unsupported WebGL falls back without errors.
4. `stage.mood` intensity visibly changes ambient glow and presence brightness; accent recolors presence and UI.
5. Objects fade out when hidden, dismissed or expired instead of vanishing.
6. A `pnpm demo` command starts Friend with a scripted fake model, so the whole look can be previewed without an API key.
7. All Phase 1 tests keep passing; every new unit has tests; no network requests are made by any new object.

## 2. Scope

**In:** protocol additions, server stage validation and prompt/tool text, client object renderers (SVG, no charting library), auto layout, exit animation, two new presence styles, mood intensity, demo script.
**Out:** map and image objects (need network or asset handling; later), camera (2b), free-form sandbox (2c), voice (Phase 5), 3D scenes.

## 3. Protocol changes (`@friend/protocol`)

- `Placement` gains the literal `"auto"`.
- `StageObject.type` gains `chart | gauge | timeline | graph` (total: card, stat, list, table, code, chart, gauge, timeline, graph).
- `PresenceStyle = "sphere" | "orb" | "ring"` (enum). `StageCommand` `presence.style`, `StageSnapshot.presence.style`, and the `stage.presence` tool use it. Default `sphere`.
- Tool descriptions for `stage.show`/`stage.presence` list the types, props shapes and styles so the model can use them.

### Object props (all optional fields tolerated; clients ignore what they cannot use)
- `chart`: `{ title?, kind: "line"|"bar"|"area", labels: string[], series: {name: string, values: number[]}[], unit? }` (max 6 series, 120 points each).
- `gauge`: `{ label, value: number, min?: number (0), max?: number (100), unit? }`.
- `timeline`: `{ title?, items: {time: string, title: string, detail?: string}[] }` (max 30 items).
- `graph`: `{ title?, nodes: {id: string, label?: string}[], edges: {from: string, to: string, label?: string}[] }` (max 40 nodes, 80 edges).
Server validates only the envelope (`props` is a record) as in Phase 1; the client enforces limits by truncating.

## 4. Client rendering

- **Pure geometry helpers** (`objects/geometry.ts`), unit tested: `niceScale(min, max, ticks)`, `scaleLinear(domain, range)`, `linePath(points)`, `arcPath(cx, cy, r, startAngle, endAngle)`, `gaugeAngle(value, min, max)`, `circleLayout(n, w, h)`, `layeredLayout` is not needed (circle layout only in 2a). Non-finite numbers are dropped, empty data renders an empty-state message.
- **Charts** are inline SVG using CSS variables (`--accent` plus a fixed secondary palette of 5 colors chosen for dark glass); axes, ticks, legend for more than one series; `font-variant-numeric: tabular-nums`; responsive via `viewBox`.
- **Gauge**: 240° arc, animated value, big tabular number, unit and label; color shifts to amber above 80% and red above 95% of the range.
- **Timeline**: vertical list with a glowing rail; times are plain strings.
- **Graph**: circular layout, curved edges with arrowheads, node labels truncated to 18 characters; edges to unknown nodes are skipped.
- Every renderer is wrapped by the existing error boundary and never uses `dangerouslySetInnerHTML`.

### Auto layout
- Objects with `placement: "auto"` render inside an `auto-grid` container: CSS grid, `repeat(auto-fit, minmax(min(280px, 100%), 1fr))`, gap 12 px, padded to keep clear of the corner presence and the safe areas; it scrolls internally if content overflows. On narrow screens it is a single column (already the Phase 1 stacking behavior).
- Objects with named or relative placements keep absolute positioning.

### Motion
- Hidden/dismissed/expired objects stay in the DOM as "ghosts" for 350 ms with a fade-and-shrink class, then are removed. Reduced motion shortens this to 0 ms.

### Presence styles
- `sphere`: unchanged.
- `orb`: a WebGL fragment-shader orb (soft core, fresnel rim, noise-driven plasma swirl); state parameters from `PresenceCore`; amplitude drives ripples and rim brightness.
- `ring`: Canvas 2D radial bars around a circle (about 96 bars), bar length from phase noise plus amplitude, thin base ring; thinking = rotating comet gap, listening = bars pulled in and brighter.
- `PresenceCore` is shared; a `createPresence(style, host, opts)` factory chooses the implementation and falls back to the 2D sphere when WebGL is unavailable. Changing `style` disposes and recreates the handle.
- `mood.intensity` (0..1) scales presence brightness (0.5 + intensity) and the ambient glow opacity.

## 5. Server changes

- `StageState` validates `presence.style` through the shared enum (invalid style yields a clear error to the model); default `sphere`.
- System prompt gains a short section on the new objects, `auto` placement, and the presence styles, and tells the model to prefer `auto` placement for several objects.
- `stage.show` TTL and object limit (12) unchanged.

## 6. Demo (`pnpm demo`)

`scripts/demo.ts` boots Friend on a temp data directory with a known throwaway owner account, a scripted `FakeProvider`, and prints the URL and credentials. Each message the viewer sends advances the script: charts and gauges, a timeline, a graph, an auto-laid dashboard, then cycling presence styles and moods. It never contacts any network service.

## 7. Testing

- Unit: geometry helpers, circle layout, ring bar math, presence factory selection, mood scaling, ghost lifecycle (fake timers).
- Component: each new object with valid, empty and malformed props; auto grid vs absolute placement; ghosts fade then disappear; presence style switch recreates the handle.
- Protocol/server: new enum values accepted, bad style rejected, snapshot carries style, prompt mentions new objects.
- Integration: a scripted agent shows a chart and switches the presence to `ring`; a new client's snapshot contains both.
- Manual: browser screenshots of every object type and presence style at desktop and phone widths via `pnpm demo`.

## 8. Risks

- Shader differences across GPUs: the orb is optional behind the existing WebGL detection and falls back safely.
- Large series or graphs: truncation limits keep rendering bounded.
- Agent-supplied strings appear only as text nodes (React escapes them).
