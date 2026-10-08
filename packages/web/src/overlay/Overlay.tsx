import type { ClientMsg, PendingApproval } from "@friend/protocol";
import type { ReactNode } from "react";
import type { Alert, Connection, LocalAction, VoiceChallenge, VoiceMode } from "../store";
import { CameraIndicator } from "../camera/CameraIndicator";
import { AlertToast } from "./AlertToast";
import { ApprovalCard } from "./ApprovalCard";
import { ChallengeCard } from "./ChallengeCard";
import { Clock } from "./Clock";
import { StatusBadge } from "./StatusBadge";
import { MicIndicator } from "./MicIndicator";

export interface OverlayProps {
  approval: PendingApproval | null;
  /** A borderline voice waiting for the owner's PIN. */
  challenge?: VoiceChallenge | null;
  /** The live camera stream, present only while the camera is open for a picture. */
  cameraStream?: MediaStream | null;
  /** Other client-owned panels, such as voice enrollment. */
  children?: ReactNode;
  alerts: Alert[];
  connection: Connection;
  deviceOnline: boolean;
  voiceMode: VoiceMode;
  /** Friend is working on a request. */
  busy?: boolean;
  /** What it is doing, in plain words. */
  activity?: string | null;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
}

/** Layer 4: always above whatever the agent has put on the stage. */
export function Overlay({ approval, challenge, cameraStream, children, alerts, connection, deviceOnline, voiceMode, busy = false, activity = null, send, dispatch }: OverlayProps) {
  return (
    <div data-overlay className="overlay" style={{ position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" }}>
      <StatusBadge connection={connection} deviceOnline={deviceOnline} approval={approval} voiceMode={voiceMode} busy={busy} activity={activity} />
      <Clock />
      <MicIndicator mode={voiceMode} />
      {cameraStream && <CameraIndicator stream={cameraStream} />}
      <AlertToast alerts={alerts} dispatch={dispatch} />
      {challenge && !approval && <ChallengeCard key={challenge.id} challenge={challenge} send={send} dispatch={dispatch} />}
      {approval && <ApprovalCard approval={approval} send={send} />}
      {children}
    </div>
  );
}
