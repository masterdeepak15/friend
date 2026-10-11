import type { PlayerAudio } from "./useMusicPlayer";

/** The part of Spotify's Web Playback SDK that Friend uses. */
export interface SpotifyPlayer {
  addListener(event: string, fn: (arg: never) => void): boolean;
  connect(): Promise<boolean>;
  disconnect(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(ms: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
}
export interface SpotifySdk {
  Player: new (o: { name: string; getOAuthToken: (cb: (token: string) => void) => void; volume?: number }) => SpotifyPlayer;
}

export interface SpotifyEngineDeps {
  loadSdk?: () => Promise<SpotifySdk>;
  /** A good access token for the owner's Spotify account (from Friend's server). */
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  /** The name Spotify shows for this screen in its list of devices. */
  deviceName?: string;
  now?: () => number;
  /** How long to wait for Spotify's player to say it is ready before giving up (default 15 seconds). */
  readyTimeoutMs?: number;
}

export type SpotifyEngine = PlayerAudio & { error: string | null };

const REF = /^spotify:([A-Za-z0-9_-]{1,64})$/;
const PREMIUM = "Spotify Premium is needed to play on this screen.";

interface SdkState {
  paused: boolean;
  position: number;
  duration: number;
  track_window: { current_track?: { id?: string }; previous_tracks?: { id?: string }[] };
}

/** The owner's access token for Spotify's player, from Friend's server (only while signed in to Friend and connected to Spotify). */
export async function fetchSpotifyToken(): Promise<string> {
  const res = await fetch("/api/music/spotify/token", { cache: "no-store" });
  if (!res.ok) throw new Error("Spotify is not connected.");
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/** Loads Spotify's own script, once, only when asked. */
export function loadSpotifySdk(): Promise<SpotifySdk> {
  const w = window as unknown as { Spotify?: SpotifySdk; onSpotifyWebPlaybackSDKReady?: () => void };
  if (w.Spotify) return Promise.resolve(w.Spotify);
  return new Promise((resolve, reject) => {
    w.onSpotifyWebPlaybackSDKReady = () => (w.Spotify ? resolve(w.Spotify) : reject(new Error("no sdk")));
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.onerror = () => reject(new Error("blocked"));
    document.head.appendChild(s);
  });
}

/**
 * Plays a Spotify track on this screen: Spotify's web player turns the browser tab into a Spotify device (the owner's account
 * must be Premium), and this drives it as if it were an audio element. Nothing is fetched from Spotify until a track is played.
 */
export function createSpotifyEngine(d: SpotifyEngineDeps): SpotifyEngine {
  const doFetch = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = d.now ?? Date.now;
  const listeners = new Map<string, Set<() => void>>();
  let player: SpotifyPlayer | null = null;
  let deviceId: string | null = null;
  let waiting: { promise: Promise<string>; resolve: (id: string) => void; reject: (e: Error) => void } | null = null;
  let uri: string | null = null;
  let badSrc = false;
  let startedUri: string | null = null;
  let endedFor: string | null = null;
  let pos = 0;
  let posAt = 0;
  let dur = 0;
  let isPaused = true;
  let vol = 1;
  let isMuted = false;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const emit = (type: string) => {
    for (const f of listeners.get(type) ?? []) f();
  };
  const effective = () => (isMuted ? 0 : vol);
  const stopTicker = () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  };
  const startTicker = () => {
    if (!ticker) ticker = setInterval(() => emit("timeupdate"), 250);
  };

  const engine: SpotifyEngine = {
    error: null,
    preload: "",
    get src() {
      return uri ?? "";
    },
    set src(v: string) {
      const m = REF.exec(v);
      badSrc = v !== "" && !m;
      uri = m ? v : null;
      startedUri = null;
      endedFor = null;
      pos = 0;
      dur = 0;
      engine.error = null;
      if (!m) stopTicker();
    },
    get currentTime() {
      return isPaused ? pos : pos + (now() - posAt) / 1000;
    },
    set currentTime(v: number) {
      pos = v;
      posAt = now();
      void player?.seek(Math.round(v * 1000)).catch(() => {});
    },
    get duration() {
      return dur;
    },
    get paused() {
      return isPaused;
    },
    get volume() {
      return vol;
    },
    set volume(v: number) {
      vol = v;
      void player?.setVolume(effective()).catch(() => {});
    },
    get muted() {
      return isMuted;
    },
    set muted(m: boolean) {
      isMuted = m;
      void player?.setVolume(effective()).catch(() => {});
    },
    async play() {
      if (badSrc || !uri) throw new Error("That is not a Spotify track.");
      const m = REF.exec(uri)!;
      const mine = uri;
      const device = await connect();
      if (uri !== mine) return; // another track was chosen while this one was starting: that one starts itself
      if (startedUri === uri) {
        await player?.resume().catch(() => {});
        isPaused = false;
        posAt = now();
        startTicker();
        return;
      }
      const token = await d.getToken().catch(() => null);
      if (!token) throw fail("Spotify is not connected. Connect it in Plugins, Spotify.");
      let res: Response;
      try {
        res = await doFetch(`https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ uris: [`spotify:track:${m[1]}`] }),
        });
      } catch {
        throw fail("Friend could not reach Spotify right now.");
      }
      if (res.status === 403) throw fail(PREMIUM);
      if (res.status === 401) throw fail("Spotify sign-in has ended. Reconnect Spotify in Plugins, Spotify.");
      if (res.status === 404) throw fail("Spotify could not find this screen or that track.");
      if (res.status === 429) throw fail("Spotify is asking Friend to slow down. Try again in a minute.");
      if (!res.ok) throw fail("Spotify could not play that.");
      if (uri !== mine) return; // changed while Spotify was answering: do not mark the new track as started
      startedUri = mine;
      isPaused = false;
      posAt = now();
      startTicker();
    },
    pause() {
      isPaused = true;
      pos = pos + (now() - posAt) / 1000;
      posAt = now();
      stopTicker();
      void player?.pause().catch(() => {});
    },
    addEventListener(type: string, fn: () => void) {
      let s = listeners.get(type);
      if (!s) listeners.set(type, (s = new Set()));
      s.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
  };

  function fail(message: string): Error {
    engine.error = message;
    isPaused = true;
    stopTicker();
    emit("error");
    const e = new Error(message);
    const w = waiting;
    waiting = null;
    w?.reject(e);
    return e;
  }

  function onState(s: SdkState | null): void {
    if (!s) return;
    pos = s.position / 1000;
    posAt = now();
    dur = s.duration / 1000;
    isPaused = s.paused;
    emit("timeupdate");
    emit("loadedmetadata");
    emit("durationchange");
    const id = uri ? REF.exec(uri)?.[1] : undefined;
    if (id && s.paused && s.position === 0 && endedFor !== uri && (s.track_window.previous_tracks ?? []).some((t) => t.id === id)) {
      endedFor = uri;
      stopTicker();
      emit("ended");
    }
  }

  /**
   * The id of this screen as a Spotify device, once Spotify's player is ready. One player is made and kept; a failure never makes
   * another, a later "ready" updates the id, and a player that never answers is given up on after a while.
   */
  function connect(): Promise<string> {
    if (deviceId) return Promise.resolve(deviceId);
    if (waiting) return waiting.promise;
    let resolve!: (id: string) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const w = { promise, resolve, reject };
    waiting = w;
    const timer = setTimeout(() => {
      if (waiting === w) fail("Spotify's player did not start. Check that this browser allows Spotify's player, then try again.");
    }, d.readyTimeoutMs ?? 15_000);
    const clear = () => clearTimeout(timer);
    promise.then(clear, clear);
    void (async () => {
      try {
        if (!player) {
          let sdk: SpotifySdk;
          try {
            sdk = await (d.loadSdk ?? loadSpotifySdk)();
          } catch {
            if (waiting === w) fail("Spotify's player could not be loaded. Check that nothing blocks sdk.scdn.co.");
            return;
          }
          const p = new sdk.Player({
            name: d.deviceName ?? "Friend",
            volume: effective(),
            getOAuthToken: (cb) => {
              void d.getToken().then(cb, () => {});
            },
          });
          player = p;
          p.addListener("ready", ((a: { device_id: string }) => {
            deviceId = a.device_id;
            const pending = waiting;
            waiting = null;
            pending?.resolve(a.device_id);
          }) as never);
          p.addListener("not_ready", (() => {
            deviceId = null;
          }) as never);
          p.addListener("player_state_changed", ((st: SdkState | null) => onState(st)) as never);
          p.addListener("account_error", (() => void fail(PREMIUM)) as never);
          p.addListener("authentication_error", (() => void fail("Spotify sign-in has ended. Reconnect Spotify in Plugins, Spotify.")) as never);
          p.addListener("initialization_error", (() => void fail("Spotify's player does not work in this browser.")) as never);
          p.addListener("playback_error", (() => void fail("Spotify could not play that.")) as never);
        }
        const ok = await player.connect();
        if (!ok && waiting === w) fail("Spotify's player could not connect.");
      } catch {
        if (waiting === w) fail("Spotify's player could not connect.");
      }
    })();
    return promise;
  }

  return engine;
}
