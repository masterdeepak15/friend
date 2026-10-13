import { useState, type ReactNode } from "react";
import "./orb.css";

export interface HoloPanelProps {
  /** The name of the dialog for screen readers. */
  label: string;
  title: string;
  /** Paging between related panels with the large arrows. Leave out when there is only one. */
  page?: { index: number; total: number; onPrev: () => void; onNext: () => void };
  children: ReactNode;
  /** The line of help at the bottom left. */
  help?: ReactNode;
  /** Leave out for a page with nothing to save. */
  onApply?: () => void;
  onDone: () => void;
  /** There are changes that were not applied: Apply is allowed, Undo is offered, and closing warns first. */
  dirty?: boolean;
  /** Something is being saved. */
  busy?: boolean;
  onUndo?: () => void;
  /** Another footer button, shown before Done (for example Reload). */
  extra?: ReactNode;
}

/** The glass panel every orb setting opens in: side bars, paging arrows, and a footer with help text, APPLY and DONE. */
export function HoloPanel({ label, title, page, children, help, onApply, onDone, dirty = false, busy = false, onUndo, extra }: HoloPanelProps) {
  const [warning, setWarning] = useState(false);
  return (
    <div className="holo-layer" style={{ pointerEvents: "none" }}>
      <div className="holo-panel" role="dialog" aria-label={label} style={{ pointerEvents: "auto" }}>
        <div className="holo-head">
          <h2 className="holo-title">{title}</h2>
          {page && (
            <div className="holo-dots" aria-label={`Page ${page.index + 1} of ${page.total}`}>
              {Array.from({ length: page.total }, (_, i) => (
                <i key={i} className={i === page.index ? "on" : ""} />
              ))}
            </div>
          )}
        </div>
        {page && (
          <>
            <button type="button" className="holo-page holo-prev" aria-label="Previous page" onClick={page.onPrev}>
              <span>Previous</span>
            </button>
            <button type="button" className="holo-page holo-next" aria-label="Next page" onClick={page.onNext}>
              <span>Next</span>
            </button>
            <span className="holo-sr" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{`Page ${page.index + 1} of ${page.total}`}</span>
          </>
        )}
        <div className="holo-body">{children}</div>
        <div className="holo-foot">
          {warning ? (
            <>
              <p className="holo-help" role="alert">
                <b>Changes not applied.</b> Closing now throws them away.
              </p>
              <div className="holo-actions">
                <button type="button" className="holo-btn" onClick={() => setWarning(false)}>
                  Keep editing
                </button>
                <button type="button" className="holo-btn warn" onClick={onDone}>
                  Discard
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="holo-help">{help}</p>
              <div className="holo-actions">
                {extra}
                {dirty && onUndo && (
                  <button type="button" className="holo-btn quiet" onClick={onUndo}>
                    Undo
                  </button>
                )}
                {onApply && (
                  <button type="button" className="holo-btn" disabled={!dirty || busy} onClick={onApply}>
                    Apply
                  </button>
                )}
                <button type="button" className="holo-btn" onClick={() => (dirty ? setWarning(true) : onDone())}>
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
