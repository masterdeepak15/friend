import type { ClientMsg, Placement, StageObject } from "@friend/protocol";
import { useCallback, useRef, useState } from "react";
import type { LocalAction } from "../store";

/** A box in fractions of the stage (0..1): x, y, width, height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_W = 0.12;
const MIN_H = 0.1;
const NUDGE = 0.02;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Keeps a box inside the stage and not smaller than a readable minimum. */
export function fit(b: Box): Box {
  const w = clamp(b.w, MIN_W, 1);
  const h = clamp(b.h, MIN_H, 1);
  return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h };
}

/** The box an object occupies on screen right now, measured from its element, as fractions of the stage. */
export function measure(el: HTMLElement, stage: HTMLElement): Box | null {
  const s = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (s.width <= 0 || s.height <= 0) return null;
  return fit({ x: (r.left - s.left) / s.width, y: (r.top - s.top) / s.height, w: r.width / s.width, h: r.height / s.height });
}

type Mode = "move" | "resize";

interface Drag {
  id: string;
  mode: Mode;
  pointer: number;
  /** Where the pointer was and what the box was when the drag began. */
  startX: number;
  startY: number;
  from: Box;
  stageW: number;
  stageH: number;
}

export interface ObjectDrag {
  /** The box being dragged right now, to draw instead of the saved one. */
  preview: { id: string; box: Box } | null;
  begin(e: React.PointerEvent, object: StageObject, mode: Mode): void;
  move(e: React.PointerEvent): void;
  end(e: React.PointerEvent, cancelled: boolean): void;
  /** Arrow keys on the grip: nudge the object (or its size, with Shift). */
  key(e: React.KeyboardEvent, object: StageObject): void;
}

/**
 * Lets the owner drag an object by its grip and resize it by its corner. The new box is sent to the server, which keeps
 * it (for a pinned widget, for good). The object may start out in a named region or in the grid: its measured box is the start.
 */
export function useObjectDrag(send: (m: ClientMsg) => void, dispatch: (a: LocalAction) => void, stageEl: () => HTMLElement | null): ObjectDrag {
  const drag = useRef<Drag | null>(null);
  const [preview, setPreview] = useState<{ id: string; box: Box } | null>(null);

  const commit = useCallback(
    (id: string, box: Box) => {
      const b = fit(box);
      const placement: Placement = { x: b.x, y: b.y, w: b.w, h: b.h };
      dispatch({ type: "object.place", id, placement });
      send({ type: "stage.move", objectId: id, rect: b });
    },
    [send, dispatch],
  );

  const begin = useCallback((e: React.PointerEvent, object: StageObject, mode: Mode) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const stage = stageEl();
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-object]");
    if (!stage || !el || drag.current) return;
    const from = measure(el, stage);
    if (!from) return;
    const s = stage.getBoundingClientRect();
    drag.current = { id: object.id, mode, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, from, stageW: s.width, stageH: s.height };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is best effort */
    }
    e.stopPropagation(); // moving an object must not start talking to the stage behind it
    e.preventDefault();
    setPreview({ id: object.id, box: from });
  }, [stageEl]);

  const boxAt = (d: Drag, e: React.PointerEvent): Box => {
    const dx = (e.clientX - d.startX) / d.stageW;
    const dy = (e.clientY - d.startY) / d.stageH;
    return d.mode === "move" ? fit({ ...d.from, x: d.from.x + dx, y: d.from.y + dy }) : fit({ ...d.from, w: d.from.w + dx, h: d.from.h + dy });
  };

  const move = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    setPreview({ id: d.id, box: boxAt(d, e) });
  }, []);

  const end = useCallback(
    (e: React.PointerEvent, cancelled: boolean) => {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId) return;
      drag.current = null;
      setPreview(null);
      if (!cancelled) commit(d.id, boxAt(d, e));
    },
    [commit],
  );

  const key = useCallback(
    (e: React.KeyboardEvent, object: StageObject) => {
      const step: Record<string, [number, number]> = { ArrowLeft: [-NUDGE, 0], ArrowRight: [NUDGE, 0], ArrowUp: [0, -NUDGE], ArrowDown: [0, NUDGE] };
      const s = step[e.key];
      const stage = stageEl();
      const el = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-object]");
      if (!s || !stage || !el) return;
      const from = measure(el, stage);
      if (!from) return;
      e.preventDefault();
      commit(object.id, e.shiftKey ? { ...from, w: from.w + s[0], h: from.h + s[1] } : { ...from, x: from.x + s[0], y: from.y + s[1] });
    },
    [commit, stageEl],
  );

  return { preview, begin, move, end, key };
}
