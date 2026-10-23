import type { OfficeWorkerView } from "@friend/protocol";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Frame } from "./kit";
import type { Rect } from "./ExpandedView";
import { usingKeyboard } from "./modality";

// the graph library is a separate piece of the page: it is fetched when the team is opened
const Graph = lazy(() => import("./OrgParts").then((m) => ({ default: m.OrgGraph })));
const Roster = lazy(() => import("./OrgParts").then((m) => ({ default: m.OrgRoster })));

export interface OrgChartProps {
  workers: OfficeWorkerView[];
  /** The assistant's own name, at the top. */
  name: string;
  rect: Rect;
  onWorker: (id: string) => void;
  onClose: () => void;
}

/** Who works for whom: the team as a graph that fills the dialog, a card for each worker beside it, and the reporting lines in plain text. */
export function OrgChart({ workers, name, rect, onWorker, onClose }: OrgChartProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: Math.max(320, rect.width - 380), h: Math.max(240, rect.height - 80) });
  useEffect(() => {
    if (usingKeyboard()) closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const byId = new Map(workers.map((w) => [w.id, w] as const));
  return (
    <Frame variant="chamfer" running title="Office team" className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label="Office team">
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body ob-org-body">
        <div className="ob-org-graph" ref={area}>
          <Suspense fallback={<p className="ob-li ob-sub">Drawing the team…</p>}>
            <Graph workers={workers} name={name} width={size.w} height={size.h} />
          </Suspense>
        </div>
        <div className="ob-org-side">
          <Suspense fallback={null}>
            <Roster workers={workers} name={name} onWorker={onWorker} />
          </Suspense>
        </div>
      </div>
      <ul className="ob-org-lines" aria-label="Who reports to whom">
        {workers.map((w) => (
          <li key={w.id}>
            {w.name} reports to {(w.managerId && byId.get(w.managerId)?.name) || name}
          </li>
        ))}
      </ul>
    </Frame>
  );
}