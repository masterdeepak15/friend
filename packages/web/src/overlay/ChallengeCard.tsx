import type { ClientMsg } from "@friend/protocol";
import { useState } from "react";
import type { LocalAction, VoiceChallenge } from "../store";
import { PinPad } from "./PinPad";
import { touch } from "./touch";

/**
 * Drawn by the client, never by the agent. A voice that was close to the owner's but not sure enough spoke these words;
 * they run only if the owner confirms with the PIN. The words are shown as plain text.
 */
export function ChallengeCard({
  challenge,
  send,
  dispatch,
}: {
  challenge: VoiceChallenge;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
}) {
  const [pin, setPin] = useState("");
  const confirm = () => {
    send({ type: "voice.confirm", id: challenge.id, pin });
    setPin("");
  };
  const dismiss = () => {
    send({ type: "voice.cancel", id: challenge.id });
    dispatch({ type: "challenge.dismiss", id: challenge.id });
  };
  return (
    <div className="approval challenge glass" role="alertdialog" aria-label="Was that you?" style={{ pointerEvents: "auto" }}>
      <div className="approval-head">
        <span className="approval-title">Was that you?</span>
      </div>
      <p className="auth-note">I heard this but I am not sure it was your voice. Enter your PIN to let it run.</p>
      <pre className="approval-summary" data-testid="challenge-text" style={{ whiteSpace: "pre-wrap" }}>
        {challenge.text}
      </pre>
      <PinPad pin={pin} onChange={setPin} onSubmit={confirm} />
      <div className="approval-actions">
        <button type="button" style={touch} className="primary" disabled={pin.length < 6} onClick={confirm}>
          Confirm
        </button>
        <button type="button" style={touch} className="danger" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
