import type { ClientMsg } from "@friend/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createSocket, type FriendSocket } from "./socket";
import { initialState, reduce, type LocalAction, type StageViewState } from "./store";
import { CameraController } from "./camera/controller";
import { ScreenController } from "./screen/capture";
import { postUtterance } from "./voice/api";
import { VoiceController } from "./voice/controller";

export interface VoiceControls {
  pressStart(): void;
  pressEnd(): void;
  blur(): void;
  /** Any click or key press: lets the browser play sound. */
  unlock(): void;
}

export function useFriend(onUnauthorized: () => void): {
  state: StageViewState;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
  voice: VoiceControls;
  useHere: () => void;
} {
  const [state, dispatch] = useReducer(reduce as (s: StageViewState, a: unknown) => StageViewState, initialState);
  const socket = useRef<FriendSocket | null>(null);
  const controller = useRef<VoiceController | null>(null);
  const camera = useRef<CameraController | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const s = createSocket();
    socket.current = s;
    const ctl = new VoiceController({
      send: (m) => s.send(m),
      dispatch: (a) => dispatch(a),
      post: postUtterance,
      available: () => latest.current.voice.available,
    });
    controller.current = ctl;
    const cam = new CameraController({
      send: (m) => s.send(m),
      dispatch: (a) => dispatch(a),
      enabled: () => latest.current.camera.enabled,
      upload: async (id, jpeg) => {
        const res = await fetch(`/api/camera/frame/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "content-type": "image/jpeg" },
          body: jpeg,
        });
        if (!res.ok) throw new Error(`upload failed (${res.status})`);
      },
    });
    camera.current = cam;
    const scr = new ScreenController({
      send: (m) => s.send(m),
      dispatch: (a) => dispatch(a),
      upload: async (id, jpeg) => {
        const res = await fetch(`/api/screen/frame/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg });
        if (!res.ok) throw new Error(`upload failed (${res.status})`);
      },
    });
    const offMsg = s.onMessage((m) => {
      dispatch(m);
      const type = (m as { type?: string; id?: unknown } | null)?.type;
      const id = (m as { id?: unknown } | null)?.id;
      if ((type === "camera.request" || type === "camera.cancel") && typeof id === "string") void cam.handle({ type, id });
      if ((type === "screen.request" || type === "screen.cancel") && typeof id === "string") void scr.handle({ type, id });
      if (type === "audio.chunk" || type === "audio.stop") ctl.handleServer(m as Parameters<VoiceController["handleServer"]>[0]);
    });
    const offState = s.onState((v) => {
      dispatch({ type: "conn", value: v });
      if (v === "unauthorized") unauthorized.current();
      if (v === "elsewhere") {
        ctl.blur(); // another window has Friend now: this one stops listening and speaking
        cam.dispose();
        scr.dispose();
      }
    });
    return () => {
      offMsg();
      offState();
      ctl.dispose();
      cam.dispose();
      scr.dispose();
      s.close();
      controller.current = null;
      camera.current = null;
      socket.current = null;
    };
  }, []);

  // switching the camera off ends any capture that is in progress
  useEffect(() => {
    if (!state.camera.enabled) camera.current?.dispose();
  }, [state.camera.enabled]);

  const send = useCallback((m: ClientMsg) => socket.current?.send(m), []);
  const local = useCallback((a: LocalAction) => dispatch(a), []);
  const voice = useMemo<VoiceControls>(
    () => ({
      pressStart: () => void controller.current?.pressStart(),
      pressEnd: () => void controller.current?.pressEnd(),
      blur: () => controller.current?.blur(),
      unlock: () => controller.current?.unlock(),
    }),
    [],
  );
  const useHere = useCallback(() => socket.current?.takeOver(), []);
  return { state, send, dispatch: local, voice, useHere };
}
