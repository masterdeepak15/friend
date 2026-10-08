import { useEffect, useRef, useState } from "react";
import { touch } from "./touch";

const NEXT_VIEW = { minimal: "companion", companion: "workspace", workspace: "minimal" } as const;

export interface OwnerMenuProps {
  muted: boolean;
  onToggleMute: () => void;
  onSignedOut: () => void;
  /** Speech is available, so the owner can teach Friend their voice. */
  voiceAvailable?: boolean;
  voiceEnrolled?: boolean;
  onEnroll?: () => void;
  /** The camera switch. The camera stays off until the owner turns it on here. */
  cameraOn?: boolean;
  onToggleCamera?: () => void;
  /** Opens the plugins panel. */
  onPlugins?: () => void;
  /** Opens the settings panel. */
  onSettings?: () => void;
  /** The conversation and schedule panels, and the view they belong to. */
  chatOn?: boolean;
  onToggleChat?: () => void;
  tasksOn?: boolean;
  onToggleTasks?: () => void;
  view?: "minimal" | "companion" | "workspace";
  onView?: (view: "minimal" | "companion" | "workspace") => void;
}

/** Manual escape hatch: Esc or a long press on the top-left corner. Works even if the agent misbehaves. */
export function OwnerMenu({ muted, onToggleMute, onSignedOut, voiceAvailable, voiceEnrolled, onEnroll, cameraOn, onToggleCamera, onPlugins, onSettings, chatOn, onToggleChat, tasksOn, onToggleTasks, view, onView }: OwnerMenuProps) {
  const [open, setOpen] = useState(false);
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  return (
    <>
      <div
        data-testid="owner-hotspot"
        className="owner-hotspot"
        style={{ position: "fixed", top: 0, left: 0, width: 56, height: 56, zIndex: 1100 }}
        onPointerDown={() => {
          cancelHold();
          hold.current = setTimeout(() => setOpen(true), 600);
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
      />
      {open && (
        <div className="owner-menu glass" role="dialog" aria-label="Owner menu" style={{ position: "fixed", zIndex: 1100 }}>
          <button type="button" style={touch} onClick={onToggleMute}>
            {muted ? "Unmute stage" : "Mute stage"}
          </button>
          {onToggleCamera && (
            <button type="button" style={touch} aria-pressed={!!cameraOn} onClick={onToggleCamera}>
              {cameraOn ? "Camera: on" : "Camera: off"}
            </button>
          )}
          {onToggleChat && (
            <button type="button" style={touch} aria-pressed={!!chatOn} onClick={onToggleChat}>
              {chatOn ? "Chat: on" : "Chat: off"}
            </button>
          )}
          {onToggleTasks && (
            <button type="button" style={touch} aria-pressed={!!tasksOn} onClick={onToggleTasks}>
              {tasksOn ? "Schedule: on" : "Schedule: off"}
            </button>
          )}
          {view && onView && (
            <button type="button" style={touch} onClick={() => onView(NEXT_VIEW[view])}>
              {`View: ${view}`}
            </button>
          )}
          {onSettings && (
            <button
              type="button"
              style={touch}
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              Settings
            </button>
          )}
          {onPlugins && (
            <button
              type="button"
              style={touch}
              onClick={() => {
                setOpen(false);
                onPlugins();
              }}
            >
              Plugins
            </button>
          )}
          {voiceAvailable && onEnroll && (
            <button
              type="button"
              style={touch}
              onClick={() => {
                setOpen(false);
                onEnroll();
              }}
            >
              {voiceEnrolled ? "Voice settings" : "Enroll my voice"}
            </button>
          )}
          <button type="button" style={touch} onClick={() => post("/api/logout")}>
            Log out
          </button>
          <button type="button" style={touch} className="danger" onClick={() => post("/api/lock")}>
            Emergency lock
          </button>
          <button type="button" style={touch} onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
