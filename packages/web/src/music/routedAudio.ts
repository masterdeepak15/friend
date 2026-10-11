import type { PlayerAudio } from "./useMusicPlayer";

const SPOTIFY_REF = /^spotify:/;

/**
 * One audio surface for the player that is really two: the browser's audio element (the music folder) and the Spotify engine (built
 * the first time a Spotify track is loaded, so Spotify's script is never fetched for someone who does not use it). The player talks
 * to this as if it were one element; what is loaded decides where the sound comes from.
 */
export class RoutedAudio implements PlayerAudio {
  private active: PlayerAudio;
  private spotify: PlayerAudio | null = null;
  private listeners = new Map<string, Set<() => void>>();
  /** The same listener, once for each engine, passing on only what the engine that is playing says. */
  private wrapped = new Map<() => void, { local: () => void; spot: () => void }>();
  private vol = 1;
  private mute = false;
  private pre = "";

  constructor(
    private local: PlayerAudio,
    private makeSpotify: () => PlayerAudio,
  ) {
    this.active = local;
  }

  /** The real audio element, for the level analyser (Spotify's own player cannot be analysed). */
  get element(): PlayerAudio {
    return this.local;
  }

  /** What went wrong in the active engine, in words for the owner, or null. */
  get error(): string | null {
    return (this.active as PlayerAudio & { error?: string | null }).error ?? null;
  }

  private wrap(fn: () => void): { local: () => void; spot: () => void } {
    let w = this.wrapped.get(fn);
    if (!w) {
      w = {
        local: () => {
          if (this.active === this.local) fn();
        },
        spot: () => {
          if (this.spotify && this.active === this.spotify) fn();
        },
      };
      this.wrapped.set(fn, w);
    }
    return w;
  }

  private spot(): PlayerAudio {
    if (!this.spotify) {
      const s = this.makeSpotify();
      s.volume = this.vol;
      s.muted = this.mute;
      s.preload = this.pre;
      for (const [type, set] of this.listeners) for (const fn of set) s.addEventListener(type, this.wrap(fn).spot);
      this.spotify = s;
    }
    return this.spotify;
  }

  /** Gives back what the Spotify engine holds (its player in the page). The audio element needs nothing. */
  dispose(): void {
    (this.spotify as (PlayerAudio & { dispose?: () => void }) | null)?.dispose?.();
    this.spotify = null;
    this.active = this.local;
  }

  get src(): string {
    return this.active.src;
  }
  set src(value: string) {
    const target = SPOTIFY_REF.test(value) ? this.spot() : this.local;
    if (target !== this.active) {
      this.active.pause();
      this.active = target;
    } else if (value === "") {
      this.active.pause();
    }
    this.active.src = value;
  }

  get currentTime(): number {
    return this.active.currentTime;
  }
  set currentTime(v: number) {
    this.active.currentTime = v;
  }
  get duration(): number {
    return this.active.duration;
  }
  get paused(): boolean {
    return this.active.paused;
  }

  get volume(): number {
    return this.vol;
  }
  set volume(v: number) {
    this.vol = v;
    this.local.volume = v;
    if (this.spotify) this.spotify.volume = v;
  }
  get muted(): boolean {
    return this.mute;
  }
  set muted(m: boolean) {
    this.mute = m;
    this.local.muted = m;
    if (this.spotify) this.spotify.muted = m;
  }
  get preload(): string {
    return this.pre;
  }
  set preload(p: string) {
    this.pre = p;
    this.local.preload = p;
    if (this.spotify) this.spotify.preload = p;
  }

  play(): Promise<void> | void {
    return this.active.play();
  }
  pause(): void {
    this.active.pause();
  }

  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
    const w = this.wrap(fn);
    this.local.addEventListener(type, w.local);
    this.spotify?.addEventListener(type, w.spot);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
    const w = this.wrap(fn);
    this.local.removeEventListener(type, w.local);
    this.spotify?.removeEventListener(type, w.spot);
  }
}
