import type { OfficeWorkerView } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";
import { Frame } from "./kit";
import type { Rect } from "./ExpandedView";
import { ORG_CARD_H, ORG_CARD_W, layoutOrg } from "./office";

export interface OrgChartProps {
  workers: OfficeWorkerView[];
  /** Friend's name, at the top. */
  name: string;
  rect: Rect;
  onWorker: (id: string) => void;
  onClose: () => void;
}

const DOT: Record<OfficeWorkerView["status"], string> = { starting: "running", running: "running", waiting: "waiting", idle: "idle", paused: "idle", stopped: "idle", failed: "failed" };

/** Who works for whom: Friend at the top, each worker under its manager, with what each is doing. Scaled to fit; a click on a card opens that worker. */
export function OrgChart({ workers, name, rect, onWorker, onClose }: OrgChartProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const layout = layoutOrg(workers);
  useEffect(() => closeRef.current?.focus(), []);
  useEffect(() => {
    const el = holder.current;
    const w = el?.clientWidth || rect.width - 24;
    const h = el?.clientHeight || rect.height - 70;
    setFit(Math.min(1, w / layout.width, h / layout.height) || 1);
  }, [layout.width, layout.height, rect.width, rect.height]);
  return (
    <Frame variant="chamfer" running title="Office team" className="ob-expanded ob-hit" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.width, height: rect.height }} role="dialog" aria-label="Office team">
      <button ref={closeRef} type="button" className="ob-close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <div className="ob-expanded-body ob-org-holder" ref={holder}>
        <div className="ob-org" style={{ width: layout.width, height: layout.height, transform: `scale(${fit})`, left: `calc(50% - ${(layout.width * fit) / 2}px)` }}>
          <svg className="ob-org-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {layout.edges.map((e) => (
              <path key={`${e.from}>${e.to}`} data-edge={`${e.from}>${e.to}`} d={`M${e.x1} ${e.y1}C${e.x1} ${(e.y1 + e.y2) / 2} ${e.x2} ${(e.y1 + e.y2) / 2} ${e.x2} ${e.y2}`} />
            ))}
          </svg>
          {layout.nodes.map((n) =>
            n.worker ? (
              <button key={n.id} type="button" className="ob-org-card" data-status={DOT[n.worker.status]} aria-label={`${n.worker.name}, ${n.worker.title}, ${n.worker.detail || n.worker.status}`} style={{ left: n.x, top: n.y, width: ORG_CARD_W, height: ORG_CARD_H }} onClick={() => onWorker(n.id)}>
                <b>
                  <i aria-hidden="true" /> {n.worker.name}
                </b>
                <span>{n.worker.title}</span>
                <small>{n.worker.detail || n.worker.status}</small>
                {n.worker.budget ? <em style={{ width: `${Math.min(100, (100 * n.worker.tokens) / n.worker.budget)}%` }} /> : null}
              </button>
            ) : (
              <div key={n.id} className="ob-org-card ob-org-root" style={{ left: n.x, top: n.y, width: ORG_CARD_W, height: ORG_CARD_H }}>
                <b>{name}</b>
                <span>Friend · the owner's assistant</span>
              </div>
            ),
          )}
        </div>
      </div>
    </Frame>
  );
}