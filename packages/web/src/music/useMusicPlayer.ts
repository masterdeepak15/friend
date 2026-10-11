import { commandToAction, parseRef, type ClientMsg, type MusicCommand, type MusicView } from "@friend/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Connection } from "../store";
import { initialPlayer, playerReducer, type PlayerAction, type PlayerState, type Track } from "./playerCore";
import { RoutedAudio } from "./routedAudio";
import { createSpotifyEngine, fetchSpotifyToken } from "./spotifyEngine";

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
  /** For tests: stands in for the Spotify engine (which is only built when a Spotify track is first loaded). */
  createSpotify?: () => PlayerAudio;
  /** The PC plays the music (the owner's choice): this player builds no audio, loads nothing and reports nothing. */
  remote?: boolean;
}

/** Where a track's sound comes from: the folder's files are streamed by Friend; a Spotify track is its own ref, played by Spotify's player; a SoundCloud track is streamed by Friend from the owner's SoundCloud account. */
const srcOf = (id: string): string => {
  const p = parseRef(id);
  return !p ? `/api/music/track/${id}` : p.source === "local" ? `/api/music/track/${p.id}` : p.source === "soundcloud" || p.source === "audius" ? `/api/music/stream/${id}` : id;
};

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

export { commandToAction } from "@friend/protocol";

/**
 * The music player's brain in the browser: the queue (playerCore), the audio element that follows it, the commands the assistant
 * sends, the reports back to the server, the phone's lock-screen controls and the analyser that makes the bars move.
 */
export function useMusicPlayer({ music, cmd, send, connection, createAudio, createSpotify, remote = false }: MusicPlayerOptions) {
  const [state, dispatch] = useReducer(reduce, undefined, () => {
    const r = recall();
    return initialPlayer({ volume: r.volume ?? 70, shuffle: r.shuffle ?? false, repeat: r.repeat ?? "all", view: r.view ?? "mini" });
  });
  const [blocked, setBlocked] = useState(false);
  /** Why the sound cannot start, in words for the owner (for example, Spotify Premium is needed), or null. */
  const [notice, setNotice] = useState<string | null>(null);
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
      const local = createAudio ? createAudio() : (new Audio() as unknown as PlayerAudio);
      const a = new RoutedAudio(local, createSpotify ?? (() => createSpotifyEngine({ getToken: fetchSpotifyToken })));
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
            const why = (audioRef.current as RoutedAudio | null)?.error ?? null;
            if (why) setNotice(why);
            else setBlocked(true);
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
  const ctxRef = useRef<AudioContext | null>(null);
  const startAnalyser = () => {
    const routed = audioRef.current;
    const a = routed instanceof RoutedAudio ? routed.element : routed;
    const Ctx = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
    if (!a || !Ctx || typeof (a as unknown as HTMLMediaElement).play !== "function") return;
    try {
      const ctx = new Ctx();
      ctxRef.current = ctx;
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
    if (remote) return;
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
    // a file that will not play is skipped; when Spotify cannot play, every track would fail the same way, so it stops and says why
    const failed = () => {
      const why = (a as RoutedAudio).error ?? null;
      setNotice(why);
      dispatch(why ? { type: "pause" } : { type: "failed" });
    };
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
      // a fresh element (and analyser) is made if the screen plays again later; what the old ones held is given back
      void ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      (a as RoutedAudio).dispose();
      lastTrack.current = null;
      audioRef.current = null;
      analyserStarted.current = false;
      setAnalyser(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  // the PC plays now: what this screen was playing stops here too, so coming back does not start it again by itself
  useEffect(() => {
    if (remote) dispatch({ type: "stop" });
  }, [remote]);

  const current: Track | null = state.index >= 0 ? (state.queue[state.index] ?? null) : null;

  // follow the queue: load the track that is current
  useEffect(() => {
    const a = audioRef.current;
    if (remote || !a) return;
    const id = current?.id ?? null;
    if (id === lastTrack.current) return;
    lastTrack.current = id;
    if (!id) {
      a.pause();
      a.src = "";
      return;
    }
    setNotice(null);
    a.src = srcOf(id);
    if (state.playing) tryPlay();
  }, [current?.id, state.playing, tryPlay, remote]);

  // follow play and pause (also a repeated track, which stays the same one)
  useEffect(() => {
    const a = audioRef.current;
    if (remote || !a || !a.src) return;
    if (state.playing && a.paused && !blockedRef.current && !attempting.current) tryPlay();
    else if (!state.playing && !a.paused) a.pause();
  }, [state.playing, state.position, tryPlay, remote]);

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
    if (connection !== "open" || remote) return;
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
  }, [connection, remote, current?.id, state.playing, state.volume, state.muted, state.shuffle, state.repeat, state.view, state.queue.length, state.index]);

  // the phone's lock screen and a keyboard's media keys
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession : undefined;
    if (!ms || remote) return;
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
  }, [current?.id, state.playing, remote]);

  return { remote: false as boolean, state, dispatch, current, blocked, notice, analyser, unlock: tryPlay, audio: audioRef };
}

export type MusicPlayer = ReturnType<typeof useMusicPlayer>;
