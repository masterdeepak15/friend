import type { ClientMsg, PendingApproval } from "@friend/protocol";
import { useState } from "react";
import { PinPad } from "./PinPad";
import { touch } from "./touch";

/** The PIN and the three answers of an approval, shared by the card and the orbital screen's approval widget so both follow the same rules. */
export function useApprovalDecision(approval: PendingApproval, send: (m: ClientMsg) => void) {
  const [pin, setPin] = useState("");
  const respond = (decision: "approve" | "approve_always" | "deny") => {
    if (decision !== "deny" && approval.needsPin) {
      send({ type: "approval.respond", id: approval.id, decision, pin });
      setPin("");
      return;
    }
    send({ type: "approval.respond", id: approval.id, decision });
  };
  const canApprove = !approval.needsPin || pin.length >= 6;
  return { pin, setPin, respond, canApprove };
}

/** Drawn by the client, never by the agent. The text comes from the server summary of the real call. */
export function ApprovalCard({ approval, send }: { approval: PendingApproval; send: (m: ClientMsg) => void }) {
  const { pin, setPin, respond, canApprove } = useApprovalDecision(approval, send);

  return (
    <div className="approval glass" role="alertdialog" aria-label="Approval needed" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className={`tier tier-${approval.tier}`}>{approval.tier}</span>
        <span className="approval-title">Approval needed</span>
      </div>
      <pre className="approval-summary" data-testid="approval-summary" style={{ whiteSpace: "pre-wrap" }}>
        {approval.summary}
      </pre>
      {approval.needsPin && <PinPad pin={pin} onChange={setPin} onSubmit={() => canApprove && respond("approve")} />}
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" disabled={!canApprove} onClick={() => respond("approve")}>
          Approve
        </button>
        {approval.tier === "T2" && !approval.needsPin && approval.tool !== "camera.snap" && !approval.tool.startsWith("office.") && (
          <button type="button" style={touch} onClick={() => respond("approve_always")}>
            Always allow
          </button>
        )}
        <button type="button" style={touch} className="danger" onClick={() => respond("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
