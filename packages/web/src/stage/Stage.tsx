import type { ClientMsg } from "@friend/protocol";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { CommandBar } from "../input/CommandBar";
import { CATALOG } from "../objects/objects";
import { Presence } from "../presence/Presence";
import type { LocalAction, StageViewState } from "../store";
import { useGhosts, type GhostEntry } from "./ghosts";
import { placementToStyle } from "./placement";

const EXIT_MS = 350;
const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  /** Push-to-talk by long-pressing the stage; omitted when voice is not wired up. */
  voice?: { pressStart(): void; pressEnd(): void };
}

const LONG_PRESS_MS = 350;

/** Layers 1–3: ambient background, voice presence, agent-placed objects, captions and the hidden command bar. */
export function Stage({ state, send, dispatch, voice }: StageProps) {
  const viewport = useViewport();
  const [openRequest, setOpenRequest] = useState(0);
  const narrow = viewport.w < 600;
  const corner = state.scene === "focus" || state.scene === "multi";
  const style = { "--accent": state.mood.accent, "--intensity": state.mood.intensity } as React.CSSProperties;
  const mode = state.voice.mode;
  const presenceState = mode === "listening" ? "listening" : mode === "speaking" ? "speaking" : mode === "transcribing" ? "thinking" : state.presence.state;
  const presenceAmplitude = mode === "listening" || mode === "speaking" ? state.voice.level : state.presence.amplitude;
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; down: boolean; talking: boolean }>({ timer: null, down: false, talking: false });
  const startPress = (e: React.PointerEvent) => {
    if (!(e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-presence]"))) return;
    const p = press.current;
    p.down = true;
    p.talking = false;
    if (voice) {
      p.timer = setTimeout(() => {
        p.talking = true;
        voice.pressStart();
      }, LONG_PRESS_MS);
    }
  };
  const endPress = (cancelled: boolean) => {
    const p = press.current;
    if (!p.down) return;
    p.down = false;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (p.talking) {
      p.talking = false;
      voice?.pressEnd();
    } else if (!cancelled) {
      setOpenRequest((n) => n + 1); // a short tap opens the text bar
    }
  };
  const entries = useGhosts(state.objects, prefersReducedMotion() ? 0 : EXIT_MS);
  const autos = entries.filter((e) => e.object.placement === "auto");
  const fixed = entries.filter((e) => e.object.placement !== "auto");

  const renderObject = ({ object: o, leaving }: GhostEntry) => {
    const View = CATALOG[o.type as keyof typeof CATALOG];
    if (!View) return null;
    return (
      <section
        key={o.id}
        className={`obj glass${o.style === "alert" ? " alert" : ""}${leaving ? " leaving" : ""}`}
        style={placementToStyle(o.placement, viewport)}
      >
        <button
          className="obj-close"
          aria-label={`Dismiss ${o.id}`}
          disabled={leaving}
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
  };

  return (
    <div
      data-testid="stage"
      className="stage"
      style={style}
      onPointerDown={startPress}
      onPointerUp={() => endPress(false)}
      onPointerCancel={() => endPress(true)}
      onContextMenu={(e) => voice && e.preventDefault()}
    >
      <div className="ambient" aria-hidden="true" style={{ opacity: 0.35 + 0.65 * state.mood.intensity }} />
      <Presence
        state={presenceState}
        amplitude={presenceAmplitude}
        pulse={state.presence.pulse}
        mode={corner ? "corner" : "full"}
        accent={state.mood.accent}
        style={state.presence.style}
        intensity={state.mood.intensity}
      />
      <div className={narrow ? "objects objects-stack" : "objects"} style={{ zIndex: 10 }}>
        {autos.length > 0 && <div className="auto-grid">{autos.map(renderObject)}</div>}
        {fixed.map(renderObject)}
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
