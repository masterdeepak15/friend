import type { ClientMsg, MusicCommand, MusicView } from "@friend/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Connection } from "../store";
import { initialPlayer, playerReducer, type PlayerAction, type PlayerState, type Track } from "./playerCore";

/** What the player needs from an audio element (a real one, or a stand-in in tests). */
export interface PlayerAudio {
  src: string;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  preload: string;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface MusicPlayerOptions {
  music: MusicView | null;
  cmd: { n: number; command: MusicCommand } | null;
  send: (m: ClientMsg) => void;
  connection: Connection;
  createAudio?: () => PlayerAudio;
}

const reduce = (s: PlayerState, a: PlayerAction): PlayerState => playerReducer(s, a);
const KEY = "friend.music";
const REPORT_MS = 1000;
const SEEK_GAP = 1.5;

interface Remembered {
  volume?: number;
  muted?: boolean;
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
  view?: "mini" | "full" | "hidden";
}
const recall = (): Remembered => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Remembered;
  } catch {
    return {};
  }
};
const remember = (s: PlayerState): void => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ volume: s.volume, muted: s.muted, shuffle: s.shuffle, repeat: s.repeat, view: s.view }));
  } catch {
    /* not remembered, still works */
  }
};

/** Turns what the assistant asked for into a step of the player. */
export function commandToAction(c: MusicCommand): PlayerAction | null {
  switch (c.action) {
    case "play":
      return { type: "play", tracks: c.tracks ?? [], mode: c.mode === "add" || c.mode === "next" ? c.mode : "replace", ...(c.shuffle ? { shuffle: true } : {}) };
    case "pause":
    case "resume":
    case "toggle":
    case "stop":
    case "next":
    case "previous":
      return { type: c.action };
    case "seek":
      return { type: "seek", ...(c.seconds !== undefined ? { seconds: c.seconds } : {}), ...(c.percent !== undefined ? { percent: c.percent } : {}) };
    case "volume":
      return { type: "volume", ...(c.level !== undefined ? { level: c.level } : {}), ...(c.delta !== undefined ? { delta: c.delta } : {}) };
    case "mute":
      return { type: "mute", ...(c.on !== undefined ? { on: c.on } : {}) };
    case "shuffle":
      return { type: "shuffle", ...(c.on !== undefined ? { on: c.on } : {}) };
    case "repeat":
      return c.mode === "off" || c.mode === "all" || c.mode === "one" ? { type: "repeat", mode: c.mode } : null;
    case "view":
      return c.view ? { type: "view", view: c.view } : null;
    case "queue.remove":
      return c.index !== undefined ? { type: "remove", index: c.index } : null;
    case "queue.clear":
      return { type: "clear" };
    default:
      return null;
  }
}

/**
 * The music player's brain in the browser: the queue (playerCore), the audio element that follows it, the commands the assistant
 * sends, the reports back to the server, the phone's lock-screen controls and the analyser that makes the bars move.
 */
export function useMusicPlayer({ music, cmd, send, connection, createAudio }: MusicPlayerOptions) {
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const r = recall();
    return initialPlayer({ volume: r.volume ?? 70, shuffle: r.shuffle ?? false, repeat: r.repeat ?? "all", view: r.view ?? "mini" });
  });
  const [blocked, setBlocked] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const audioRef = useRef<PlayerAudio | null>(null);
  const blockedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const interacted = useRef(false);
  const lastTrack = useRef<string | null>(null);
  const lastCmd = useRef(0);
  const settled = useRef(false);

  // the owner's settings are the starting point, until the player has been touched or the browser remembers its own
  useEffect(() => {
    if (!music || settled.current) return;
    settled.current = true;
    const r = recall();
    dispatch({ type: "volume", level: r.volume ?? music.volume });
    dispatch({ type: "repeat", mode: r.repeat ?? music.repeat });
    if (r.shuffle ?? music.shuffle) dispatch({ type: "shuffle", on: true });
    dispatch({ type: "view", view: r.view ?? music.startView });
    if (r.muted) dispatch({ type: "mute", on: true });
  }, [music]);

  const audio = (): PlayerAudio => {
    if (!audioRef.current) {
      const a = createAudio ? createAudio() : (new Audio() as unknown as PlayerAudio);
      a.preload = "auto";
      audioRef.current = a;
    }
    return audioRef.current;
  };

  const attempting = useRef(false);
  const tryPlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || !a.src) return;
    attempting.current = true;
    try {
      const p = a.play();
      if (p && typeof (p as Promise<void>).then === "function") {
        (p as Promise<void>).then(
          () => {
            attempting.current = false;
            setBlocked(false);
          },
          () => {
            attempting.current = false;
            setBlocked(true);
          },
        );
      } else {
        attempting.current = false;
        setBlocked(false);
      }
    } catch {
      attempting.current = false;
      setBlocked(true);
    }
    // the first successful play also connects the analyser (it needs a user gesture to start)
    if (!analyserStarted.current) startAnalyser();
  }, []);
  const analyserStarted = useRef(false);
  const startAnalyser = () => {
    const a = audioRef.current;
    const Ctx = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!a || !Ctx || typeof (a as unknown as HTMLMediaElement).play !== "function") return;
    try {
      const ctx = new Ctx();
      const node = ctx.createMediaElementSource(a as unknown as HTMLMediaElement);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.82;
      node.connect(an);
      an.connect(ctx.destination);
      analyserStarted.current = true;
      setAnalyser(an);
    } catch {
      analyserStarted.current = true; // not available here: the bars fall back to a gentle motion
    }
  };

  // the audio element and what it tells us
  useEffect(() => {
    const a = audio();
    let lastTime = 0;
    const time = () => {
      const now = Date.now();
      if (now - lastTime < 250) return;
      lastTime = now;
      dispatch({ type: "time", position: a.currentTime || 0, duration: Number.isFinite(a.duration) ? a.duration : 0 });
    };
    const meta = () => dispatch({ type: "time", position: a.currentTime || 0, duration: Number.isFinite(a.duration) ? a.duration : 0 });
    const ended = () => dispatch({ type: "ended" });
    const failed = () => dispatch({ type: "failed" });
    a.addEventListener("timeupdate", time);
    a.addEventListener("loadedmetadata", meta);
    a.addEventListener("durationchange", meta);
    a.addEventListener("ended", ended);
    a.addEventListener("error", failed);
    return () => {
      a.removeEventListener("timeupdate", time);
      a.removeEventListener("loadedmetadata", meta);
      a.removeEventListener("durationchange", meta);
      a.removeEventListener("ended", ended);
      a.removeEventListener("error", failed);
      a.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current: Track | null = state.index >= 0 ? (state.queue[state.index] ?? null) : null;

  // follow the queue: load the track that is current
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const id = current?.id ?? null;
    if (id === lastTrack.current) return;
    lastTrack.current = id;
    if (!id) {
      a.pause();
      a.src = "";
      return;
    }
    a.src = `/api/music/track/${id}`;
    if (state.playing) tryPlay();
  }, [current?.id, state.playing, tryPlay]);

  // follow play and pause (also a repeated track, which stays the same one)
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !a.src) return;
    if (state.playing && a.paused && !blockedRef.current && !attempting.current) tryPlay();
    else if (!state.playing && !a.paused) a.pause();
  }, [state.playing, state.position, tryPlay]);

  // follow volume and a seek
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.volume = state.volume / 100;
    a.muted = state.muted;
  }, [state.volume, state.muted]);
  useEffect(() => {
    const a = audioRef.current;
    if (a && a.src && Math.abs((a.currentTime || 0) - state.position) > SEEK_GAP) a.currentTime = state.position;
  }, [state.position]);

  useEffect(() => remember(state), [state.volume, state.muted, state.shuffle, state.repeat, state.view]);

  // what the assistant asked for
  useEffect(() => {
    if (!cmd || cmd.n === lastCmd.current) return;
    lastCmd.current = cmd.n;
    const action = commandToAction(cmd.command);
    if (action) dispatch(action);
  }, [cmd]);

  // the first touch makes this the screen the assistant's commands reach, and lets blocked sound start
  useEffect(() => {
    const touch = () => {
      interacted.current = true;
      if (blockedRef.current) tryPlay();
    };
    window.addEventListener("pointerdown", touch, { passive: true });
    window.addEventListener("keydown", touch);
    return () => {
      window.removeEventListener("pointerdown", touch);
      window.removeEventListener("keydown", touch);
    };
  }, [tryPlay]);
  blockedRef.current = blocked;

  // tell the server what is going on (so the assistant can say what is playing)
  const reported = useRef(0);
  useEffect(() => {
    if (connection !== "open") return;
    const report = () => {
      const s = stateRef.current;
      const cur = s.index >= 0 ? s.queue[s.index] : undefined;
      reported.current = Date.now();
      send({
        type: "music.state",
        state: {
          playing: s.playing,
          trackId: cur?.id ?? null,
          title: cur?.title ?? "",
          artist: cur?.artist ?? "",
          album: cur?.album ?? "",
          position: s.position,
          duration: s.duration,
          volume: s.volume,
          muted: s.muted,
          shuffle: s.shuffle,
          repeat: s.repeat,
          view: s.view,
          queue: s.queue.slice(0, 50).map((t) => ({ id: t.id, title: t.title.slice(0, 200) })),
          index: s.index,
          active: typeof document === "undefined" ? interacted.current : document.visibilityState === "visible" && interacted.current,
        },
      });
    };
    report();
    const id = setInterval(() => state.playing && Date.now() - reported.current >= REPORT_MS && report(), REPORT_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, current?.id, state.playing, state.volume, state.muted, state.shuffle, state.repeat, state.view, state.queue.length, state.index]);

  // the phone's lock screen and a keyboard's media keys
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession : undefined;
    if (!ms) return;
    try {
      if (current && typeof MediaMetadata !== "undefined") ms.metadata = new MediaMetadata({ title: current.title, artist: current.artist, album: current.album, artwork: [{ src: `/api/music/cover/${current.id}` }] });
      ms.playbackState = state.playing ? "playing" : current ? "paused" : "none";
      ms.setActionHandler("play", () => dispatch({ type: "resume" }));
      ms.setActionHandler("pause", () => dispatch({ type: "pause" }));
      ms.setActionHandler("previoustrack", () => dispatch({ type: "previous" }));
      ms.setActionHandler("nexttrack", () => dispatch({ type: "next" }));
      ms.setActionHandler("seekto", (d) => typeof d.seekTime === "number" && dispatch({ type: "seek", seconds: d.seekTime }));
    } catch {
      /* this browser has no lock-screen controls */
    }
  }, [current?.id, state.playing]);

  return { state, dispatch, current, blocked, analyser, unlock: tryPlay, audio: audioRef };
}

export type MusicPlayer = ReturnType<typeof useMusicPlayer>;
