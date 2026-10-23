import type { OfficeWorkerView } from "@friend/protocol";
import { Suspense, lazy, useEffect, useRef } from "react";
import { Frame } from "./kit";
import type { Rect } from "./ExpandedView";

// the graph library is a separate piece of the page: it is fetched when the team is opened
const Graph = lazy(() => import("./OrgGraph"));

export interface OrgChartProps {
  workers: OfficeWorkerView[];
  /** The assistant's own name, at the top. */
  name: string;
  rect: Rect;
  onWorker: (id: string) => void;
  onClose: () => void;
}

const DOT: Record<OfficeWorkerView["status"], string> = { starting: "running", running: "running", waiting: "waiting", idle: "idle", paused: "idle", stopped: "idle", failed: "failed" };

/** Who works for whom: a graph of the team drawn with the Jarvis components, a plain list of the reporting lines, and a button for each worker to open it. */
export function OrgChart({ workers, name, rect, onWorker, onClose }: OrgChartProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const byId = new Map(workers.map((w) => [w.id, w] as const));
  return (
    <Frame variant="chamfer" running title="Office team" className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label="Office team">
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body ob-org-holder">
        <div className="ob-org-graph">
          <Suspense fallback={<p className="ob-li ob-sub">Drawing the team…</p>}>
            <Graph workers={workers} name={name} />
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
      <div className="ob-org-chips">
        {workers.map((w) => (
          <button key={w.id} type="button" className="ob-org-chip" data-status={DOT[w.status]} aria-label={`${w.name}, ${w.title}, ${w.detail || w.status}`} onClick={() => onWorker(w.id)}>
            <i aria-hidden="true" /> {w.name} · {w.title}
          </button>
        ))}
      </div>
    </Frame>
  );
}