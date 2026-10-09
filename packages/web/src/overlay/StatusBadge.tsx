import type { PendingApproval } from "@friend/protocol";
import { Movable } from "../layout/Movable";
import type { Connection, VoiceMode } from "../store";

export interface StatusInput {
  connection: Connection;
  deviceOnline: boolean;
  approval: PendingApproval | null;
  voiceMode: VoiceMode;
  busy: boolean;
  activity: string | null;
}

export type StatusKind = "offline" | "waiting" | "listening" | "working" | "speaking" | "idle";

/** One plain line about what Friend is doing, so the owner is never left guessing. The most urgent thing wins. */
export function describeStatus(s: StatusInput): { kind: StatusKind; text: string } {
  if (s.connection === "unauthorized") return { kind: "offline", text: "Signed out" };
  if (s.connection === "elsewhere") return { kind: "offline", text: "Open in another window" };
  if (s.connection !== "open") return { kind: "offline", text: "Reconnecting…" };
  if (s.approval) return { kind: "waiting", text: "Waiting for your approval" };
  if (s.voiceMode === "listening") return { kind: "listening", text: "Listening" };
  if (s.voiceMode === "transcribing") return { kind: "working", text: "Understanding what you said" };
  if (s.busy) return { kind: s.activity === "Answering" ? "speaking" : "working", text: `${s.activity ?? "Thinking"}…` };
  if (s.voiceMode === "speaking") return { kind: "speaking", text: "Speaking" };
  return { kind: "idle", text: s.deviceOnline ? "Ready" : "Ready (no device connected)" };
}

/** Bottom-left corner: always on, small, and it changes as Friend works. */
export function StatusBadge(props: StatusInput) {
  const { kind, text } = describeStatus(props);
  return (
    <Movable id="status" label="Status line" wholeBox testId="status-badge" className={`status-badge status-${kind}`}>
      <i aria-hidden="true" />
      <span role="status" aria-live="polite">
        {text}
      </span>
    </Movable>
  );
}
