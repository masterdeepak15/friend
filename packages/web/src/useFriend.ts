import type { ClientMsg } from "@friend/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createSocket, type FriendSocket } from "./socket";
import { initialState, reduce, type LocalAction, type StageViewState } from "./store";
import { postUtterance } from "./voice/api";
import { VoiceController } from "./voice/controller";

export interface VoiceControls {
  pressStart(): void;
  pressEnd(): void;
  blur(): void;
}

export function useFriend(onUnauthorized: () => void): {
  state: StageViewState;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
  voice: VoiceControls;
} {
  const [state, dispatch] = useReducer(reduce as (s: StageViewState, a: unknown) => StageViewState, initialState);
  const socket = useRef<FriendSocket | null>(null);
  const controller = useRef<VoiceController | null>(null);
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
    const offMsg = s.onMessage((m) => {
      dispatch(m);
      const type = (m as { type?: string } | null)?.type;
      if (type === "audio.chunk" || type === "audio.stop") ctl.handleServer(m as Parameters<VoiceController["handleServer"]>[0]);
    });
    const offState = s.onState((v) => {
      dispatch({ type: "conn", value: v });
      if (v === "unauthorized") unauthorized.current();
    });
    return () => {
      offMsg();
      offState();
      ctl.dispose();
      s.close();
      controller.current = null;
      socket.current = null;
    };
  }, []);

  const send = useCallback((m: ClientMsg) => socket.current?.send(m), []);
  const local = useCallback((a: LocalAction) => dispatch(a), []);
  const voice = useMemo<VoiceControls>(
    () => ({
      pressStart: () => void controller.current?.pressStart(),
      pressEnd: () => void controller.current?.pressEnd(),
      blur: () => controller.current?.blur(),
    }),
    [],
  );
  return { state, send, dispatch: local, voice };
}
