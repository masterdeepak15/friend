import type { MusicCommand, MusicTrackRef } from "./messages";
import type { RepeatMode } from "./hud";

export type Track = MusicTrackRef;
export type PlayerView = "mini" | "full" | "hidden";

/** Everything the player knows. `playing` is what should be happening; the audio element follows it. */
export interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  view: PlayerView;
}

export type PlayerAction =
  | { type: "play"; tracks: Track[]; mode: "replace" | "add" | "next"; shuffle?: boolean; start?: number }
  | { type: "next" }
  | { type: "previous" }
  | { type: "ended" }
  | { type: "failed" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "toggle" }
  | { type: "stop" }
  | { type: "volume"; level?: number; delta?: number }
  | { type: "mute"; on?: boolean }
  | { type: "seek"; seconds?: number; percent?: number }
  | { type: "repeat"; mode: RepeatMode }
  | { type: "shuffle"; on?: boolean }
  | { type: "view"; view: PlayerView }
  | { type: "remove"; index: number }
  | { type: "clear" }
  | { type: "jump"; index: number }
  | { type: "time"; position: number; duration: number };

export const MAX_QUEUE = 2000;
/** A track that has played this long restarts when "previous" is pressed, as in most players. */
const RESTART_AFTER = 3;

export const initialPlayer = (o: { volume: number; shuffle: boolean; repeat: RepeatMode; view: PlayerView }): PlayerState => ({
  queue: [],
  index: -1,
  playing: false,
  position: 0,
  duration: 0,
  volume: o.volume,
  muted: false,
  shuffle: o.shuffle,
  repeat: o.repeat,
  view: o.view,
});

export function shuffled<T>(items: T[], random: () => number = Math.random): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const reset = (s: PlayerState, index: number, playing: boolean): PlayerState => ({ ...s, index, playing, position: 0, duration: 0 });

/** One step: the same state and action always give the same new state (the shuffle can be given, so a test can be exact). */
export function playerReducer(s: PlayerState, a: PlayerAction, env: { shuffle?: <T>(items: T[]) => T[] } = {}): PlayerState {
  const mix = env.shuffle ?? shuffled;
  const last = s.queue.length - 1;
  switch (a.type) {
    case "play": {
      if (a.tracks.length === 0) return s;
      const incoming = a.tracks.slice(0, MAX_QUEUE);
      if (a.mode === "replace") {
        const queue = a.shuffle ? mix(incoming) : incoming;
        return { ...reset(s, a.shuffle ? 0 : clamp(a.start ?? 0, 0, queue.length - 1), true), queue, shuffle: a.shuffle ? true : s.shuffle };
      }
      if (s.queue.length === 0) return { ...reset(s, 0, true), queue: incoming };
      const at = a.mode === "next" ? s.index + 1 : s.queue.length;
      return { ...s, queue: [...s.queue.slice(0, at), ...incoming, ...s.queue.slice(at)].slice(0, MAX_QUEUE) };
    }
    case "next": {
      if (last < 0) return s;
      if (s.index < last) return reset(s, s.index + 1, true);
      return s.repeat === "off" ? { ...s, playing: false, position: 0 } : reset(s, 0, true);
    }
    case "previous": {
      if (last < 0) return s;
      if (s.position > RESTART_AFTER) return { ...s, position: 0 };
      if (s.index > 0) return reset(s, s.index - 1, s.playing || true);
      return s.repeat === "all" ? reset(s, last, true) : { ...s, position: 0 };
    }
    case "ended": {
      if (last < 0) return s;
      if (s.repeat === "one") return reset(s, s.index, true);
      if (s.index < last) return reset(s, s.index + 1, true);
      return s.repeat === "all" ? reset(s, 0, true) : { ...s, playing: false, position: 0 };
    }
    case "failed": {
      if (last < 0) return s;
      return s.index < last ? reset(s, s.index + 1, true) : { ...s, playing: false, position: 0 };
    }
    case "pause":
      return s.playing ? { ...s, playing: false } : s;
    case "resume":
      return s.index >= 0 && !s.playing ? { ...s, playing: true } : s;
    case "toggle":
      return s.index < 0 ? s : { ...s, playing: !s.playing };
    case "stop":
      return { ...s, playing: false, position: 0 };
    case "volume": {
      const level = typeof a.level === "number" ? Math.round(a.level) : typeof a.delta === "number" ? s.volume + Math.round(a.delta) : s.volume;
      return { ...s, volume: clamp(level, 0, 100), muted: typeof a.level === "number" || (a.delta ?? 0) > 0 ? false : s.muted };
    }
    case "mute":
      return { ...s, muted: a.on ?? !s.muted };
    case "seek": {
      const to = typeof a.seconds === "number" ? a.seconds : typeof a.percent === "number" ? (s.duration * clamp(a.percent, 0, 100)) / 100 : s.position;
      return { ...s, position: clamp(to, 0, s.duration > 0 ? s.duration : Math.max(to, 0)) };
    }
    case "repeat":
      return { ...s, repeat: a.mode };
    case "shuffle": {
      const on = a.on ?? !s.shuffle;
      if (!on) return { ...s, shuffle: false };
      const head = s.queue.slice(0, s.index + 1);
      return { ...s, shuffle: true, queue: [...head, ...mix(s.queue.slice(s.index + 1))] };
    }
    case "view":
      return { ...s, view: a.view };
    case "remove": {
      if (!Number.isInteger(a.index) || a.index < 0 || a.index > last) return s;
      const queue = s.queue.filter((_, i) => i !== a.index);
      if (queue.length === 0) return { ...s, queue, index: -1, playing: false, position: 0, duration: 0 };
      if (a.index < s.index) return { ...s, queue, index: s.index - 1 };
      if (a.index > s.index) return { ...s, queue };
      // the playing track was removed: the one after it takes its place
      if (a.index < queue.length) return { ...reset(s, a.index, s.playing), queue };
      return s.repeat === "all" ? { ...reset(s, 0, s.playing), queue } : { ...s, queue, index: queue.length - 1, playing: false, position: 0 };
    }
    case "clear":
      return { ...s, queue: [], index: -1, playing: false, position: 0, duration: 0 };
    case "jump":
      return Number.isInteger(a.index) && a.index >= 0 && a.index <= last ? reset(s, a.index, true) : s;
    case "time":
      return { ...s, position: Math.max(0, a.position), duration: Math.max(0, a.duration) };
  }
}

/** Turns what the assistant asked for into a step of the player. */
export function commandToAction(c: MusicCommand): PlayerAction | null {
  switch (c.action) {
    case "play":
      return { type: "play", tracks: c.tracks ?? [], mode: c.mode === "add" || c.mode === "next" ? c.mode : "replace", ...(c.shuffle ? { shuffle: true } : {}), ...(c.index !== undefined ? { start: c.index } : {}) };
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
    case "jump":
      return c.index !== undefined ? { type: "jump", index: c.index } : null;
    default:
      return null;
  }
}

/** The other way round: what a screen sends the PC's player for a button the person pressed. Null for what a player does by itself. */
export function actionToCommand(a: PlayerAction): MusicCommand | null {
  switch (a.type) {
    case "play":
      return { action: "play", tracks: a.tracks, mode: a.mode, ...(a.shuffle ? { shuffle: true } : {}), ...(a.start !== undefined ? { index: a.start } : {}) };
    case "next":
    case "previous":
    case "pause":
    case "resume":
    case "toggle":
    case "stop":
      return { action: a.type };
    case "volume":
      return { action: "volume", ...(a.level !== undefined ? { level: a.level } : {}), ...(a.delta !== undefined ? { delta: a.delta } : {}) };
    case "mute":
      return { action: "mute", ...(a.on !== undefined ? { on: a.on } : {}) };
    case "seek":
      return { action: "seek", ...(a.seconds !== undefined ? { seconds: a.seconds } : {}), ...(a.percent !== undefined ? { percent: a.percent } : {}) };
    case "repeat":
      return { action: "repeat", mode: a.mode };
    case "shuffle":
      return { action: "shuffle", ...(a.on !== undefined ? { on: a.on } : {}) };
    case "view":
      return { action: "view", view: a.view };
    case "remove":
      return { action: "queue.remove", index: a.index };
    case "clear":
      return { action: "queue.clear" };
    case "jump":
      return { action: "jump", index: a.index };
    default:
      return null;
  }
}
