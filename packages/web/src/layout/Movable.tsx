import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { loadPos, savePos, type PanelId, type Pos } from "./prefs";

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const STEP = 2;

/**
 * Lets the owner drag a panel anywhere on the screen. Drag the handle (the whole box when `wholeBox` is set), use the
 * arrow keys on the focused handle, double-click it to put the panel back. The place is remembered in this browser.
 */
export function Movable({
  id,
  label,
  className,
  style,
  wholeBox,
  head,
  testId,
  children,
}: {
  id: PanelId;
  label: string;
  className?: string;
  style?: CSSProperties;
  /** The whole box is the handle (small widgets); otherwise only `head` is. */
  wholeBox?: boolean;
  head?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<Pos | null>(() => loadPos(id));
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ dx: number; dy: number; pointer: number } | null>(null);

  const place = (x: number, y: number, remember: boolean) => {
    const next = { x: clamp(x, 0, 95), y: clamp(y, 0, 95) };
    setPos(next);
    if (remember) savePos(id, next);
    return next;
  };

  const handle = {
    onPointerDown: (e: React.PointerEvent) => {
      const el = box.current;
      if (!el || (e.pointerType === "mouse" && e.button !== 0)) return;
      if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return; // controls inside keep working
      const r = el.getBoundingClientRect();
      drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, pointer: e.pointerId };
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture is best effort */
      }
      e.stopPropagation(); // dragging a panel must not start talking to the stage behind it
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId) return;
      place(((e.clientX - d.dx) / window.innerWidth) * 100, ((e.clientY - d.dy) / window.innerHeight) * 100, false);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId) return;
      drag.current = null;
      const r = box.current?.getBoundingClientRect();
      if (r) place((r.left / window.innerWidth) * 100, (r.top / window.innerHeight) * 100, true);
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onDoubleClick: () => {
      savePos(id, null);
      setPos(null);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      const r = box.current?.getBoundingClientRect();
      if (!r) return;
      const x = (r.left / window.innerWidth) * 100;
      const y = (r.top / window.innerHeight) * 100;
      const move: Record<string, [number, number]> = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
      const m = move[e.key];
      if (!m) return;
      e.preventDefault();
      place(x + m[0], y + m[1], true);
    },
    tabIndex: 0,
    role: "group" as const,
    "aria-label": `${label}. Drag to move, arrow keys to nudge, double-click to put it back.`,
  };

  const placed: CSSProperties = pos ? { left: `${pos.x}%`, top: `${pos.y}%`, right: "auto", bottom: "auto" } : {};
  return (
    <div
      ref={box}
      data-panel={id}
      data-testid={testId}
      className={`movable ${className ?? ""}`}
      style={{ pointerEvents: "auto", ...style, ...placed }}
      {...(wholeBox ? handle : {})}
    >
      {head !== undefined && (
        <div className="panel-head" {...(wholeBox ? {} : handle)}>
          {head}
        </div>
      )}
      {children}
    </div>
  );
}
