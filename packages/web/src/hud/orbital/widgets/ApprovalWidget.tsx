import type { ClientMsg, PendingApproval } from "@friend/protocol";
import { PinPad } from "../../../overlay/PinPad";
import { useApprovalDecision } from "../../../overlay/ApprovalCard";

/** The orange octagon: a warning, what is being asked, the PIN when one is needed, and the answers. Dim when nothing is waiting. */
export function ApprovalWidget({ approval, send }: { approval: PendingApproval | null; send: (m: ClientMsg) => void }) {
  if (!approval) return <p className="ob-li ob-sub">None waiting</p>;
  return <Waiting approval={approval} send={send} />;
}

function Waiting({ approval, send }: { approval: PendingApproval; send: (m: ClientMsg) => void }) {
  const { pin, setPin, respond, canApprove } = useApprovalDecision(approval, send);
  return (
    <div className="ob-approval" role="alertdialog" aria-label="Approval needed">
      <svg className="ob-tri" viewBox="0 0 56 52" aria-hidden="true">
        <path d="M4 48L28 4L52 48Z" />
        <text x="28" y="42" textAnchor="middle">!</text>
      </svg>
      <div className="ob-appr-text">
        <span className="ob-appr-title">
          APPROVAL NEEDED <span className={`tier tier-${approval.tier}`}>{approval.tier}</span>
        </span>
        <span className="ob-appr-sub">{approval.tool} wants to run:</span>
        <pre className="ob-summary" data-testid="approval-summary">{approval.summary}</pre>
      </div>
      {approval.needsPin && <PinPad pin={pin} onChange={setPin} onSubmit={() => canApprove && respond("approve")} />}
      <div className="ob-actions">
        <button type="button" className="ob-btn ob-yes" disabled={!canApprove} onClick={() => respond("approve")}>
          Approve
        </button>
        {approval.tier === "T2" && !approval.needsPin && approval.tool !== "camera.snap" && (
          <button type="button" className="ob-btn" onClick={() => respond("approve_always")}>
            Always allow
          </button>
        )}
        <button type="button" className="ob-btn ob-no" onClick={() => respond("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}