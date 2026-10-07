import type { ClientMsg } from "@friend/protocol";
import { Component, useEffect, useState, type ReactNode } from "react";
import { CommandBar } from "../input/CommandBar";
import { CATALOG } from "../objects/objects";
import { Presence } from "../presence/Presence";
import type { LocalAction, StageViewState } from "../store";
import { placementToStyle } from "./placement";

class Safe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return v;
}

export interface StageProps {
  state: StageViewState;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
}

/** Layers 1–3: ambient background, voice presence, agent-placed objects, captions and the hidden command bar. */
export function Stage({ state, send, dispatch }: StageProps) {
  const viewport = useViewport();
  const [openRequest, setOpenRequest] = useState(0);
  const narrow = viewport.w < 600;
  const corner = state.scene === "focus" || state.scene === "multi";
  const style = { "--accent": state.mood.accent, "--intensity": state.mood.intensity } as React.CSSProperties;

  return (
    <div
      data-testid="stage"
      className="stage"
      style={style}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-presence]")) setOpenRequest((n) => n + 1);
      }}
    >
      <div className="ambient" aria-hidden="true" />
      <Presence
        state={state.presence.state}
        amplitude={state.presence.amplitude}
        pulse={state.presence.pulse}
        mode={corner ? "corner" : "full"}
        accent={state.mood.accent}
      />
      <div className={narrow ? "objects objects-stack" : "objects"} style={{ zIndex: 10 }}>
        {state.objects.map((o) => {
          const View = CATALOG[o.type as keyof typeof CATALOG];
          if (!View) return null;
          return (
            <section key={o.id} className={`obj glass${o.style === "alert" ? " alert" : ""}`} style={placementToStyle(o.placement, viewport)}>
              <button
                className="obj-close"
                aria-label={`Dismiss ${o.id}`}
                onClick={() => {
                  send({ type: "stage.event", objectId: o.id, event: "dismiss" });
                  dispatch({ type: "object.dismiss", id: o.id });
                }}
              >
                ×
              </button>
              <Safe>
                <View props={o.props} />
              </Safe>
            </section>
          );
        })}
      </div>
      {state.captions && (
        <p className={`captions${state.captionDone ? " done" : ""}`} aria-live="polite">
          {state.captions}
        </p>
      )}
      <CommandBar requestOpen={openRequest} onSend={(text) => send({ type: "chat.send", text })} />
    </div>
  );
}
