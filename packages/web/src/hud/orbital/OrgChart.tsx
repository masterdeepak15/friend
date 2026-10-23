import type { OfficeWorkerView } from "@friend/protocol";
import { Suspense, lazy, useEffect, useRef } from "react";
import { Frame } from "./kit";
import type { Rect } from "./ExpandedView";
import { usingKeyboard } from "./modality";

// the card library is a separate piece of the page: it is fetched when the team is opened
const Canvas = lazy(() => import("./OrgParts").then((m) => ({ default: m.OrgCanvas })));

export interface OrgChartProps {
  workers: OfficeWorkerView[];
  /** The assistant's own name, on the left. */
  name: string;
  rect: Rect;
  onWorker: (id: string) => void;
  onClose: () => void;
}

/** Who works for whom, as a canvas you can move and zoom: a Jarvis card for each worker, and the lines of who reports to whom. */
export function OrgChart({ workers, name, rect, onWorker, onClose }: OrgChartProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (usingKeyboard()) closeRef.current?.focus();
  }, []);
  return (
    <Frame variant="chamfer" running title="Office team" className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label="Office team">
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body ob-org-body">
        <Suspense fallback={<p className="ob-li ob-sub">Drawing the team…</p>}>
          <Canvas workers={workers} name={name} onWorker={onWorker} />
        </Suspense>
      </div>
      <ul className="ob-org-lines" aria-label="Who reports to whom">
        {workers.map((w) => (
          <li key={w.id}>
            {w.name} reports to {(w.managerId && workers.find((x) => x.id === w.managerId)?.name) || name}
          </li>
        ))}
      </ul>
    </Frame>
  );
}