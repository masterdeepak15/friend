import type { ClientMsg } from "@friend/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { createSocket, type FriendSocket } from "./socket";
import { initialState, reduce, type LocalAction, type StageViewState } from "./store";

export function useFriend(onUnauthorized: () => void): {
  state: StageViewState;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
} {
  const [state, dispatch] = useReducer(reduce as (s: StageViewState, a: unknown) => StageViewState, initialState);
  const socket = useRef<FriendSocket | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;

  useEffect(() => {
    const s = createSocket();
    socket.current = s;
    const offMsg = s.onMessage(dispatch);
    const offState = s.onState((v) => {
      dispatch({ type: "conn", value: v });
      if (v === "unauthorized") unauthorized.current();
    });
    return () => {
      offMsg();
      offState();
      s.close();
      socket.current = null;
    };
  }, []);

  const send = useCallback((m: ClientMsg) => socket.current?.send(m), []);
  const local = useCallback((a: LocalAction) => dispatch(a), []);
  return { state, send, dispatch: local };
}
