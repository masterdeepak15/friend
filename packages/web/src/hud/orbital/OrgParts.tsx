import { JArcReactor, JCard, JDataRow, JStatusPill } from "@masterdeepak15/jarvis-ui";
import "@masterdeepak15/jarvis-ui/styles";
import type { OfficeWorkerView } from "@friend/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NODE_H, NODE_W, canvasLayout, clampView, fitView, zoomAt, type View } from "./canvas";

type Color = "cyan" | "green" | "amber" | "red" | "ghost";
const COLOR: Record<OfficeWorkerView["status"], Color> = { starting: "green", running: "green", waiting: "amber", idle: "cyan", paused: "ghost", stopped: "ghost", failed: "red" };
const PILL: Record<OfficeWorkerView["status"], "active" | "warning" | "error" | "success"> = { starting: "active", running: "active", waiting: "warning", idle: "success", paused: "warning", stopped: "warning", failed: "error" };
const SHOWN: Record<OfficeWorkerView["status"], string> = { starting: "running", running: "running", waiting: "waiting", idle: "idle", paused: "idle", stopped: "idle", failed: "failed" };
const short = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

/** What the buttons do to the zoom. */
const STEP = 1.25;

/**
 * The team as a canvas: the assistant on the left and each worker as a Jarvis card to the right of its manager, joined by lines. The view
 * moves with the mouse (drag), zooms with the wheel (around the pointer) or the buttons, can be fitted back at any time, and can never be
 * pushed so far that the team is lost.
 */
export function OrgCanvas({ workers, name, onWorker }: { workers: OfficeWorkerView[]; name: string; onWorker: (id: string) => void }) {
  const room = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => canvasLayout(workers), [workers]);
  const world = useMemo(() => ({ width: layout.width, height: layout.height }), [layout.width, layout.height]);
  const [size, setSize] = useState({ width: 640, height: 420 });
  const [view, setView] = useState<View>(() => fitView(world, size));
  const moved = useRef(false); // the person has moved the view: stop fitting it by itself
  const dragged = useRef(false); // the last press became a drag: the click that follows it is not a click on a worker
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number; far: boolean } | null>(null);
  const status = new Map(workers.map((w) => [w.id, w.status] as const));

  const apply = useCallback((v: View) => setView(clampView(v, world, size)), [world, size]);
  const fit = useCallback(() => {
    moved.current = false;
    setView(fitView(world, size));
  }, [world, size]);

  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // until the person moves the view, it keeps the whole team in sight as the team or the room changes
  useEffect(() => {
    if (!moved.current) setView(fitView(world, size));
  }, [world, size]);

  // the wheel zooms around the pointer (it has to be a listener that may cancel the page scroll)
  useEffect(() => {
    const el = room.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      moved.current = true;
      setView((v) => clampView(zoomAt(v, { x: e.clientX - r.left, y: e.clientY - r.top }, Math.exp(-e.deltaY * 0.0015)), world, size));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [world, size]);

  const centre = { x: size.width / 2, y: size.height / 2 };
  const zoomBy = (f: number) => {
    moved.current = true;
    apply(zoomAt(view, centre, f));
  };

  return (
    <div className="ob-canvas-room" ref={room}>
      <div
        className="ob-canvas-pan"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragged.current = false;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, id: e.pointerId, far: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.far && Math.hypot(dx, dy) < 5) return;
          if (!d.far) e.currentTarget.setPointerCapture?.(d.id); // only a real drag takes the pointer, so a plain click still reaches the node
          d.far = true;
          dragged.current = true;
          moved.current = true;
          apply({ k: view.k, x: d.vx + dx, y: d.vy + dy });
        }}
        onPointerUp={(e) => {
          drag.current = null;
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={() => (drag.current = null)}
      >
        <div className="ob-canvas-world" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="ob-canvas-edges" width={layout.width} height={layout.height} aria-hidden="true">
            <defs>
              <marker id="ob-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" className="ob-arrow" />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const s = status.get(e.to);
              const mid = (e.x1 + e.x2) / 2;
              return <path key={`${e.from}>${e.to}`} d={`M${e.x1} ${e.y1}C${mid} ${e.y1} ${mid} ${e.y2} ${e.x2} ${e.y2}`} markerEnd="url(#ob-arrow)" data-flow={s === "running" || s === "starting" ? "on" : s === "waiting" ? "wait" : "off"} />;
            })}
          </svg>
          {layout.nodes.map((n) => {
            const w = n.worker;
            if (!w)
              return (
                <div key={n.id} className="ob-cnode ob-cnode-root" data-node="friend" style={{ left: n.x, top: n.y, width: n.w, height: NODE_H }}>
                  <JArcReactor size={92} color="cyan" label={name.toUpperCase()} animated />
                  <small>the assistant</small>
                </div>
              );
            const share = w.budget && w.budget > 0 ? Math.min(100, (100 * w.tokens) / w.budget) : undefined;
            return (
              <div
                key={n.id}
                className="ob-cnode"
                role="button"
                tabIndex={0}
                data-node={n.id}
                data-status={SHOWN[w.status]}
                aria-label={`${w.name}, ${w.title}, ${w.detail || w.status}`}
                style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                onClick={() => {
                  if (dragged.current) dragged.current = false;
                  else onWorker(n.id);
                }}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onWorker(n.id))}
              >
                <JCard
                  cardStyle="SideRail"
                  color={COLOR[w.status]}
                  padding="8px 12px"
                  header={
                    <div className="ob-cnode-head">
                      <b>{w.name}</b>
                      <JStatusPill state={PILL[w.status]}>{w.status.toUpperCase()}</JStatusPill>
                    </div>
                  }
                >
                  <JDataRow label="JOB" value={w.title} />
                  <JDataRow label="DOING" value={w.detail || w.status} />
                  <JDataRow label="TOKENS" value={short(w.tokens)} {...(share !== undefined ? { barPercent: share } : {})} />
                </JCard>
              </div>
            );
          })}
        </div>
      </div>
      <div className="ob-canvas-tools" role="toolbar" aria-label="View of the team">
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(STEP)}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / STEP)}>
          −
        </button>
        <button type="button" aria-label="Fit the team" onClick={fit}>
          ⤢
        </button>
        <span aria-hidden="true">{Math.round(view.k * 100)}%</span>
      </div>
    </div>
  );
}