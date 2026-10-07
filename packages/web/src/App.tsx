import { useEffect, useMemo, useState } from "react";
import { LoginScreen } from "./auth/LoginScreen";
import { SetupScreen } from "./auth/SetupScreen";
import { OwnerMenu } from "./overlay/OwnerMenu";
import { Overlay } from "./overlay/Overlay";
import { Stage } from "./stage/Stage";
import { useFriend } from "./useFriend";

type Phase = "loading" | "setup" | "login" | "stage";

function StageApp({ onSignedOut }: { onSignedOut: () => void }) {
  const { state, send, dispatch } = useFriend(onSignedOut);
  const [muted, setMuted] = useState(false);
  const shown = useMemo(() => (muted ? { ...state, objects: [], captions: "" } : state), [muted, state]);
  return (
    <>
      <Stage state={shown} send={send} dispatch={dispatch} />
      <Overlay
        approval={state.approval}
        alerts={state.alerts}
        connection={state.connection}
        deviceOnline={state.deviceOnline}
        send={send}
        dispatch={dispatch}
      />
      <OwnerMenu muted={muted} onToggleMute={() => setMuted((m) => !m)} onSignedOut={onSignedOut} />
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
