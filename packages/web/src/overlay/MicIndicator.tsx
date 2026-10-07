import type { VoiceMode } from "../store";

/** Always visible while the microphone is open. It lives in the client-owned overlay, so the agent cannot hide it. */
export function MicIndicator({ mode }: { mode: VoiceMode }) {
  if (mode !== "listening" && mode !== "transcribing") return null;
  return (
    <div className={`mic-indicator mic-${mode}`} role="status" aria-label="Microphone">
      <i aria-hidden="true" />
      {mode === "listening" ? "Listening…" : "Transcribing…"}
    </div>
  );
}
