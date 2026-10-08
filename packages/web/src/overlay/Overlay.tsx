import type { ClientMsg, PendingApproval } from "@friend/protocol";
import type { ReactNode } from "react";
import type { Alert, Connection, LocalAction, VoiceChallenge, VoiceMode } from "../store";
import { AlertToast } from "./AlertToast";
import { ApprovalCard } from "./ApprovalCard";
import { ChallengeCard } from "./ChallengeCard";
import { MicIndicator } from "./MicIndicator";

export interface OverlayProps {
  approval: PendingApproval | null;
  /** A borderline voice waiting for the owner's PIN. */
  challenge?: VoiceChallenge | null;
  /** Other client-owned panels, such as voice enrollment. */
  children?: ReactNode;
  alerts: Alert[];
  connection: Connection;
  deviceOnline: boolean;
  voiceMode: VoiceMode;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
}

/** Layer 4: always above whatever the agent has put on the stage. */
export function Overlay({ approval, challenge, children, alerts, connection, deviceOnline, voiceMode, send, dispatch }: OverlayProps) {
  const badge =
    connection !== "open" ? "Reconnecting…" : !deviceOnline ? "No device connected" : null;
  return (
    <div data-overlay className="overlay" style={{ position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" }}>
      {badge && (
        <div className="conn-badge" role="status">
          {badge}
        </div>
      )}
      <MicIndicator mode={voiceMode} />
      <AlertToast alerts={alerts} dispatch={dispatch} />
      {challenge && !approval && <ChallengeCard key={challenge.id} challenge={challenge} send={send} dispatch={dispatch} />}
      {approval && <ApprovalCard approval={approval} send={send} />}
      {children}
    </div>
  );
}
