import { useEffect, useMemo, useRef, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { SetupScreen } from "./auth/SetupScreen";
import { OwnerMenu } from "./overlay/OwnerMenu";
import { Overlay } from "./overlay/Overlay";
import { Stage } from "./stage/Stage";
import { useFriend } from "./useFriend";
import { PluginsPanel } from "./plugins/PluginsPanel";
import { EnrollmentFlow } from "./voice/EnrollmentFlow";
import { useVoiceKeys } from "./voice/keys";
import { useAudioUnlock } from "./voice/unlock";

type Phase = "loading" | "setup" | "login" | "stage";

function StageApp({ onSignedOut }: { onSignedOut: () => void }) {
  const { state, send, dispatch, voice } = useFriend(onSignedOut);
  useVoiceKeys(voice);
  useAudioUnlock(voice);
  const [muted, setMuted] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [managingPlugins, setManagingPlugins] = useState(false);
  const shown = useMemo(() => (muted ? { ...state, objects: [], captions: "" } : state), [muted, state]);

  // Once per visit, when speech works but nobody's voice is enrolled yet, say how to turn recognition on.
  const reminded = useRef(false);
  useEffect(() => {
    if (reminded.current || !state.voice.available || state.voice.enrolled) return;
    reminded.current = true;
    dispatch({ type: "alert.add", level: "info", text: "Voice recognition is not set up. Press Esc, then Enroll my voice." });
  }, [state.voice.available, state.voice.enrolled, dispatch]);

  return (
    <>
      <Stage state={shown} send={send} dispatch={dispatch} voice={voice} />
      <Overlay
        approval={state.approval}
        challenge={state.challenge}
        cameraStream={state.camera.stream}
        alerts={state.alerts}
        connection={state.connection}
        deviceOnline={state.deviceOnline}
        voiceMode={state.voice.mode}
        send={send}
        dispatch={dispatch}
      >
        {enrolling && <EnrollmentFlow onClose={() => setEnrolling(false)} />}
        {managingPlugins && <PluginsPanel onClose={() => setManagingPlugins(false)} />}
      </Overlay>
      <OwnerMenu
        muted={muted}
        onToggleMute={() => setMuted((m) => !m)}
        onSignedOut={onSignedOut}
        voiceAvailable={state.voice.available}
        voiceEnrolled={state.voice.enrolled}
        onEnroll={() => setEnrolling(true)}
        onPlugins={() => setManagingPlugins(true)}
        cameraOn={state.camera.enabled}
        onToggleCamera={() => dispatch({ type: "camera.enable", value: !state.camera.enabled })}
      />
    </>
  );
}

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json() as Promise<{ hasOwner: boolean }>)
      .then((s) => setPhase(s.hasOwner ? "stage" : "setup"))
      .catch(() => setPhase("stage"));
  }, []);

  if (phase === "loading") return <div className="boot" aria-busy="true" />;
  if (phase === "setup") return <SetupScreen onDone={() => setPhase("login")} />;
  if (phase === "login") return <LoginScreen onLoggedIn={() => setPhase("stage")} />;
  return <StageApp onSignedOut={() => setPhase("login")} />;
}
