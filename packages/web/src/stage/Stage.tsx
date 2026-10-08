import type { ClientMsg } from "@friend/protocol";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { CommandBar } from "../input/CommandBar";
import type { Slash } from "../input/commands";
import { TouchControls } from "../input/TouchControls";
import { useCoarsePointer } from "../input/useCoarsePointer";
import { reactivityFactor } from "../presence/reactivity";
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
  voice?: { pressStart(): void; pressEnd(): void; blur?(): void };
  /** The / commands of the message bar; without them a line starting with / is sent like any other. */
  slash?: Slash;
  /** On a touch screen (no Esc key) a button opens the owner menu. */
  onMenu?: () => void;
}

const LONG_PRESS_MS = 350;

/** Layers 1–3: ambient background, voice presence, agent-placed objects, captions and the hidden command bar. */
export function Stage({ state, send, dispatch, voice, slash, onMenu }: StageProps) {
  const viewport = useViewport();
  const [openRequest, setOpenRequest] = useState(0);
  const [barOpen, setBarOpen] = useState(false);
  const coarse = useCoarsePointer();
  const narrow = viewport.w < 600;
  const corner = state.scene === "focus" || state.scene === "multi";
  const style = { "--accent": state.mood.accent, "--intensity": state.mood.intensity } as React.CSSProperties;
  const mode = state.voice.mode;
  const presenceState = mode === "listening" ? "listening" : mode === "speaking" ? "speaking" : mode === "transcribing" ? "thinking" : state.presence.state;
  const reactivity = reactivityFactor(state.look.reactivity); // 1 at the default, so nothing changes until the owner asks
  const presenceAmplitude = Math.min(1, (mode === "listening" || mode === "speaking" ? state.voice.level : state.presence.amplitude) * reactivity);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; down: boolean; talking: boolean; id: number | null }>({
    timer: null,
    down: false,
    talking: false,
    id: null,
  });
  const startPress = (e: React.PointerEvent) => {
    if (!(e.target === e.currentTarget || (e.target as HTMLElement).closest("[data-presence]"))) return;
    if (e.pointerType === "mouse" && e.button !== 0) return; // right and middle buttons are not a press
    const p = press.current;
    if (p.down && p.id !== null && e.pointerId !== p.id) return; // a second finger while one is already down
    if (p.timer) clearTimeout(p.timer); // never stack timers
    p.down = true;
    p.talking = false;
    p.id = typeof e.pointerId === "number" ? e.pointerId : null;
    try {
      // keep receiving the release even if the pointer leaves the stage or the window
      if (p.id !== null) (e.currentTarget as HTMLElement).setPointerCapture?.(p.id);
    } catch {
      /* capture is best effort */
    }
    p.timer = voice
      ? setTimeout(() => {
          if (!p.down) return;
          p.talking = true;
          voice.pressStart();
        }, LONG_PRESS_MS)
      : null;
  };
  const endPress = (e: React.PointerEvent, cancelled: boolean) => {
    const p = press.current;
    if (!p.down) return;
    if (p.id !== null && typeof e.pointerId === "number" && e.pointerId !== p.id) return; // another finger
    p.down = false;
    p.id = null;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    if (p.talking) {
      p.talking = false;
      if (cancelled) voice?.blur?.(); // a cancelled gesture discards the recording
      else voice?.pressEnd();
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
      onPointerUp={(e) => endPress(e, false)}
      onPointerCancel={(e) => endPress(e, true)}
      onContextMenu={(e) => voice && e.preventDefault()}
    >
      {state.look.ambient && <div className="ambient" aria-hidden="true" style={{ opacity: 0.35 + 0.65 * state.mood.intensity }} />}
      <Presence
        state={presenceState}
        amplitude={presenceAmplitude}
        pulse={state.presence.pulse}
        mode={corner ? "corner" : "full"}
        accent={state.mood.accent}
        style={state.presence.style}
        intensity={state.mood.intensity}
        scale={state.look.size}
      />
      <div className={narrow ? "objects objects-stack" : "objects"} style={{ zIndex: 10 }}>
        {autos.length > 0 && <div className="auto-grid">{autos.map(renderObject)}</div>}
        {fixed.map(renderObject)}
      </div>
      {state.look.captions && state.captions && (
        <p className={`captions captions-${state.look.captionSize}${state.captionDone ? " done" : ""}`} aria-live="polite">
          {state.captions}
        </p>
      )}
      {coarse && voice && !barOpen && <TouchControls voice={voice} mode={mode} onType={() => setOpenRequest((n) => n + 1)} onMenu={() => onMenu?.()} />}
      <CommandBar requestOpen={openRequest} slash={slash} onOpenChange={setBarOpen} onSend={(text) => send({ type: "chat.send", text })} />
    </div>
  );
}
