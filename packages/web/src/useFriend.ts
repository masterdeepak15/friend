import type { ClientMsg } from "@friend/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createSocket, type FriendSocket } from "./socket";
import { initialState, reduce, type LocalAction, type StageViewState } from "./store";
import { CameraController } from "./camera/controller";
import { ScreenController } from "./screen/capture";
import { analyzeScreen, measureScreen } from "./screen/inspect";
import { pageDuck } from "./audio/duck";
import { useDuckReporting } from "./audio/useDuckReporting";
import { postUtterance, postWake } from "./voice/api";
import { chime } from "./voice/chime";
import { HandsFree } from "./voice/handsfree";
import { Listener } from "./voice/listener";
import { VoiceController } from "./voice/controller";

export interface VoiceControls {
  pressStart(): void;
  pressEnd(): void;
  blur(): void;
  /** Any click or key press: lets the browser play sound. */
  unlock(): void;
  /** The voice is kept off: nothing is spoken until it is back on. Captions and chat still show. */
  setQuiet(on: boolean): void;
}

export function useFriend(onUnauthorized: () => void): {
  state: StageViewState;
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
  voice: VoiceControls;
  /** Hands-free listening for the assistant's name. It is a choice of this device, remembered here. */
  handsFree: { on: boolean; supported: boolean; toggle: () => void };
  useHere: () => void;
  officeStop: (workerId?: string) => void;
  officeSay: (workerId: string, text: string) => void;
} {
  const [state, dispatch] = useReducer(reduce as (s: StageViewState, a: unknown) => StageViewState, initialState);
  const socket = useRef<FriendSocket | null>(null);
  const controller = useRef<VoiceController | null>(null);
  const quietRef = useRef(false); // kept here too, so a controller made later (after a reconnect) starts quiet
  const camera = useRef<CameraController | null>(null);
  const hands = useRef<HandsFree | null>(null);
  const [handsOn, setHandsOn] = useState(false);
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
    ctl.setQuiet(quietRef.current);
    const hf = new HandsFree({
      makeListener: (o) => new Listener(o),
      wake: postWake,
      command: postUtterance,
      mode: () => latest.current.voice.mode,
      chime,
      dispatch: (a) => dispatch(a),
    });
    hands.current = hf;
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
      if (type === "screen.check" && typeof id === "string") {
        // let what was just drawn finish laying out, then measure it and report in words
        setTimeout(() => s.send({ type: "screen.checked", id, lines: analyzeScreen(measureScreen(document, window)) }), 500);
      }
      if (type === "audio.duck") pageDuck.set((m as { level?: number }).level ?? 1); // music and video on this screen turn down while someone talks
      if (type === "audio.chunk" || type === "audio.stop") ctl.handleServer(m as Parameters<VoiceController["handleServer"]>[0]);
    });
    const offState = s.onState((v) => {
      dispatch({ type: "conn", value: v });
      if (v !== "open") pageDuck.set(1, 0); // the server cannot say it is over any more: the sound must not stay down
      if (v === "unauthorized") unauthorized.current();
      if (v === "elsewhere") {
        hf.disable(); // another window has Friend now: this one stops listening for the name too
        setHandsOn(false);
        ctl.blur(); // another window has Friend now: this one stops listening and speaking
        cam.dispose();
        scr.dispose();
      }
    });
    return () => {
      offMsg();
      offState();
      hf.disable();
      hands.current = null;
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

  // hands-free stops collecting while Friend talks or a key is held
  useEffect(() => {
    hands.current?.sync();
  }, [state.voice.mode]);

  const setHands = useCallback(async (on: boolean) => {
    const hf = hands.current;
    if (!hf) return;
    if (on) await hf.enable();
    else hf.disable();
    setHandsOn(hf.enabled);
    try {
      localStorage.setItem("friend.handsFree", hf.enabled ? "1" : "0");
    } catch {
      /* private window: the choice just is not remembered */
    }
  }, []);

  // this device was left listening for the name: start again once speech is known to be available
  const wasOn = useRef(false);
  useEffect(() => {
    if (wasOn.current || !state.voice.available) return;
    wasOn.current = true;
    try {
      if (localStorage.getItem("friend.handsFree") === "1" && Listener.supported()) void setHands(true);
    } catch {
      /* no storage */
    }
  }, [state.voice.available, setHands]);

  const handsFree = useMemo(
    () => ({ on: handsOn, supported: Listener.supported(), toggle: () => void setHands(!hands.current?.enabled) }),
    [handsOn, setHands],
  );

  const send = useCallback((m: ClientMsg) => socket.current?.send(m), []);
  // say when the owner is talking to Friend or Friend is speaking, so music and video can be turned down meanwhile
  useDuckReporting(state.voice.mode, send);
  const local = useCallback((a: LocalAction) => dispatch(a), []);
  const voice = useMemo<VoiceControls>(
    () => ({
      pressStart: () => void controller.current?.pressStart(),
      pressEnd: () => void controller.current?.pressEnd(),
      blur: () => controller.current?.blur(),
      unlock: () => controller.current?.unlock(),
      setQuiet: (on: boolean) => {
        quietRef.current = on;
        controller.current?.setQuiet(on);
      },
    }),
    [],
  );
  const useHere = useCallback(() => socket.current?.takeOver(), []);
  const officeStop = useCallback((workerId?: string) => send({ type: "office.stop", ...(workerId ? { workerId } : {}) }), [send]);
  const officeSay = useCallback((workerId: string, text: string) => send({ type: "office.say", workerId, text }), [send]);
  return { state, send, dispatch: local, voice, handsFree, useHere, officeStop, officeSay };
}
