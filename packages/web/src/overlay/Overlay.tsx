import type { ClientMsg, PendingApproval } from "@friend/protocol";
import type { Alert, Connection, LocalAction } from "../store";
import { AlertToast } from "./AlertToast";
import { ApprovalCard } from "./ApprovalCard";

export interface OverlayProps {
  approval: PendingApproval | null;
  alerts: Alert[];
  connection: Connection;
  deviceOnline: boolean;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
}

/** Layer 4: always above whatever the agent has put on the stage. */
export function Overlay({ approval, alerts, connection, deviceOnline, send, dispatch }: OverlayProps) {
  const badge =
    connection !== "open" ? "Reconnecting…" : !deviceOnline ? "No device connected" : null;
  return (
    <div data-overlay className="overlay" style={{ position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" }}>
      {badge && (
        <div className="conn-badge" role="status">
          {badge}
        </div>
      )}
      <AlertToast alerts={alerts} dispatch={dispatch} />
      {approval && <ApprovalCard approval={approval} send={send} />}
    </div>
  );
}
