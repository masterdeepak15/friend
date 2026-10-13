import { useEffect, useMemo, useReducer, useRef } from "react";
import type { OwnerMenuProps } from "../overlay/OwnerMenu";
import { Orb, type OrbState } from "./Orb";
import { RadialMenu } from "./RadialMenu";
import { buildCategories, caption, menuReducer, type MenuState, type OrbItem } from "./radialModel";
import "./orb.css";

export interface OrbMenuProps extends OwnerMenuProps {
  /** The page's voice mode and whether Friend is working, so the orb can say LISTENING or BUSY. */
  voiceMode?: string;
  busy?: boolean;
  /** Go back to the plain list menu. */
  onClassic: () => void;
}

const SHUT: MenuState = { open: false, category: null, hover: null };

/**
 * The owner menu as a glowing orb with two rings of arcs. It appears on Esc or on pressing and holding the top-left corner,
 * and offers exactly what the classic list offers. Nothing is drawn while it is closed.
 */
export function OrbMenu(props: OrbMenuProps) {
  const { onSignedOut, onClassic, openRequest, assistantName = "", voiceMode = "idle", busy = false } = props;
  const [s, dispatch] = useReducer(menuReducer, SHUT);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (openRequest) dispatch({ type: "open" });
  }, [openRequest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "escape" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // the orb is the first thing the keyboard reaches when the menu opens
  useEffect(() => {
    if (s.open && !s.category) svg.current?.querySelector<SVGGElement>(".orb-core")?.focus();
  }, [s.open, s.category]);

  const post = async (path: string) => {
    try {
      await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } catch {
      /* the session ends either way */
    }
    onSignedOut();
  };
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };

  const categories = buildCategories(props, {
    logout: () => void post("/api/logout"),
    lock: () => void post("/api/lock"),
    classic: onClassic,
  });
  const words = useMemo(() => caption(s, categories, voiceMode, busy), [s, categories, voiceMode, busy]);
  const state: OrbState = s.open ? (s.hover ? "hover" : "menu-open") : busy ? "busy" : "idle";
  const pick = (item: OrbItem) => {
    item.run();
    if (item.kind !== "toggle") dispatch({ type: "close" });
  };

  return (
    <>
      <div
        data-testid="owner-hotspot"
        className="owner-hotspot"
        style={{ position: "fixed", top: 0, left: 0, width: 56, height: 56, zIndex: 1100 }}
        onPointerDown={() => {
          cancelHold();
          hold.current = setTimeout(() => dispatch({ type: "open" }), 600);
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
      />
      {s.open && (
        <div className="orb-layer" role="dialog" aria-label="Menu" style={{ position: "fixed", zIndex: 1100 }}>
          <div className="orb-backdrop" onPointerDown={() => dispatch({ type: "close" })} />
          <svg ref={svg} className="orb-svg" viewBox="-300 -300 600 600" aria-label="Menu">
            <defs>
              <radialGradient id="orb-disc" cx="50%" cy="45%" r="60%">
                <stop offset="0%" stopColor="#0d2530" />
                <stop offset="100%" stopColor="#03090d" />
              </radialGradient>
            </defs>
            <RadialMenu categories={categories} state={s} onCategory={(id) => dispatch({ type: "category", id })} onHover={(id) => dispatch({ type: "hover", id })} onPick={pick} />
            <Orb name={assistantName} caption={words} state={state} onClick={() => dispatch({ type: "close" })} />
          </svg>
        </div>
      )}
    </>
  );
}
