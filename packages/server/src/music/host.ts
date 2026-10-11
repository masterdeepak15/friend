import { commandToAction, initialPlayer, parseRef, playerReducer, programProblem, type MusicCommand, type MusicState, type PlayerAction, type PlayerState, type Track } from "@friend/protocol";
import type { MusicLibrary } from "./library";
import type { Mpv, MpvEvent } from "./mpv";
import { isSoundCloudAddress, type SoundCloudHub } from "./soundcloud";
import type { SpotifyHub } from "./spotify";

export interface HostDeps {
  library: Pick<MusicLibrary, "resolve" | "ready">;
  mpv: Pick<Mpv, "start" | "load" | "pause" | "seek" | "volume" | "mute" | "stop" | "onEvent" | "dispose">;
  spotify: Pick<SpotifyHub, "playOn" | "control" | "playbackState" | "status">;
  /** SoundCloud tracks are played by mpv from the address SoundCloud gives at the moment the track starts. */
  soundcloud?: Pick<SoundCloudHub, "streamOf">;
  settings: () => { volume: number; shuffle: boolean; repeat: "off" | "all" | "one"; spotifyDevice: string; hostPlayer: string };
  /** Told the player's state at once on every change, and at most once a second while the time moves. */
  emit: (state: MusicState) => void;
  /** Told when playback ends for a reason the owner should hear and no command is waiting for the answer (mpv died, Spotify stopped answering). */
  onError?: (text: string) => void;
  clock?: () => number;
}

/** The actions that start a track from the beginning. */
const RESET = new Set<PlayerAction["type"]>(["play", "next", "previous", "ended", "failed", "jump", "remove"]);
const MAX_FAILS = 5;
const POLL_MS = 2000;
const REPORT_MS = 1000;
const NO_DEVICE = "Name the Spotify device to play on in Settings, Widgets.";

/**
 * The PC's own music player, with no browser: the same queue the screen player runs (one shared reducer), with the folder's tracks
 * played by mpv and Spotify's on the Spotify device the owner named. It takes the same commands and reports the same state, so
 * the assistant and the screen treat it like any other player.
 */
export class HostPlayer {
  private s: PlayerState;
  private loadedId: string | null = null;
  private engine: "folder" | "spotify" | null = null;
  private deviceId: string | null = null;
  private fails = 0;
  /** The SoundCloud track whose address was already fetched again after mpv failed on it. */
  private retried: string | null = null;
  private err: string | null = null;
  private poll: ReturnType<typeof setInterval> | undefined;
  private seen = false;
  private pollFails = 0;
  private polling = false;
  private lastPos = 0;
  private lastEmit = -Infinity;
  private chain: Promise<unknown> = Promise.resolve();
  private off: () => void;
  private disposed = false;

  constructor(private d: HostDeps) {
    const st = d.settings();
    this.s = initialPlayer({ volume: st.volume, shuffle: st.shuffle, repeat: st.repeat, view: "mini" });
    this.off = d.mpv.onEvent((e) => this.onMpv(e));
  }

  private now = (): number => (this.d.clock ?? Date.now)();

  available(): { ok: true } | { ok: false; reason: string } {
    const problem = programProblem(this.d.settings().hostPlayer.trim());
    return problem ? { ok: false, reason: `The player program set in Settings cannot be used. ${problem}` } : { ok: true };
  }

  lastError(): string | null {
    return this.err;
  }

  state(): MusicState {
    const s = this.s;
    const cur = s.index >= 0 ? s.queue[s.index] : undefined;
    return {
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
      active: true,
    };
  }

  async command(c: MusicCommand): Promise<{ ok: boolean; text: string }> {
    const action = commandToAction(c);
    if (!action) return { ok: false, text: `I do not know the music control "${c.action}".` };
    const av = this.available();
    if (!av.ok) return { ok: false, text: av.reason };
    return this.run(() => this.apply(action));
  }

  stop(): Promise<void> {
    return this.run(() => this.apply({ type: "stop" })).then(() => undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.off();
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.d.mpv.dispose();
  }

  // ---- one thing at a time ----

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(() => fn());
    this.chain = p.catch(() => {});
    return p;
  }

  private report(force: boolean): void {
    if (this.disposed) return;
    if (!force && this.now() - this.lastEmit < REPORT_MS) return;
    this.lastEmit = this.now();
    this.d.emit(this.state());
  }

  /** Playback ended for a reason nobody asked about: remember it and tell the screens. */
  private fail(text: string): void {
    this.err = text;
    this.d.onError?.(text);
  }

  /** `notify`: when it fails there is no one to answer, so the screens are told. */
  private async apply(a: PlayerAction, notify = false): Promise<{ ok: boolean; text: string }> {
    if (this.disposed) return { ok: false, text: "The player has stopped." };
    if (a.type !== "failed" && a.type !== "ended") this.err = null;
    const prev = this.s;
    const next = playerReducer(prev, a);
    this.s = next;
    try {
      await this.drive(prev, next, a);
      this.syncPoll();
      this.report(true);
      return { ok: true, text: "Done." };
    } catch (e) {
      const text = e instanceof Error ? e.message : "The player could not do that.";
      this.err = text;
      this.s = { ...this.s, playing: false };
      this.syncPoll();
      this.report(true);
      if (notify) this.d.onError?.(text);
      return { ok: false, text };
    }
  }

  /** Makes the engines match what the queue now says. */
  private async drive(prev: PlayerState, next: PlayerState, a: PlayerAction): Promise<void> {
    if (a.type === "time") return;
    const cur = next.index >= 0 ? next.queue[next.index] : undefined;
    if (!cur || a.type === "stop") {
      await this.stopEngine();
      this.loadedId = null;
      return;
    }
    const restarted = RESET.has(a.type) && next.position === 0 && next.duration === 0 && !(a.type === "play" && a.mode !== "replace" && prev.queue.length > 0) && !(a.type === "remove" && prev.index !== a.index);
    if (next.playing && (this.loadedId !== cur.id || restarted)) {
      await this.load(cur);
      return;
    }
    if (a.type === "volume" || a.type === "mute") await this.applyVolume();
    if (a.type === "seek" || (a.type === "previous" && prev.index === next.index)) await this.seekEngine(next.position);
    if (this.loadedId === cur.id && prev.playing !== next.playing) await this.pauseEngine(!next.playing);
  }

  private async load(track: Track): Promise<void> {
    if (this.disposed) throw new Error("The player has stopped.");
    const p = parseRef(track.id);
    if (!p) throw new Error("That track cannot be played here.");
    if (this.retried && this.retried !== track.id) this.retried = null;
    if (p.source === "soundcloud") {
      if (!this.d.soundcloud) throw new Error("SoundCloud is not available on this PC.");
      await this.leaveSpotify();
      const s = await this.d.soundcloud.streamOf(p.id);
      if (!s.ok || !isSoundCloudAddress(s.url)) return this.skip();
      if (this.disposed) throw new Error("The player has stopped.");
      this.engine = "folder";
      await this.d.mpv.load(s.url);
      this.loadedId = track.id;
      this.fails = 0;
      await this.applyVolume();
      return;
    }
    if (p.source === "local") {
      await this.leaveSpotify();
      await this.d.library.ready();
      const path = await this.d.library.resolve(p.id);
      if (!path) return this.skip();
      if (this.disposed) throw new Error("The player has stopped.");
      this.engine = "folder";
      await this.d.mpv.load(path);
      this.loadedId = track.id;
      this.fails = 0;
      await this.applyVolume();
      return;
    }
    const device = this.d.settings().spotifyDevice.trim();
    if (!device) throw new Error(NO_DEVICE);
    await this.leaveFolder();
    if (this.disposed) throw new Error("The player has stopped.");
    const r = await this.d.spotify.playOn(device, [p.id]);
    if (!r.ok) throw new Error(r.error);
    this.deviceId = r.deviceId;
    this.engine = "spotify";
    this.loadedId = track.id;
    this.seen = false;
    this.lastPos = 0;
    this.fails = 0;
    await this.applyVolume();
  }

  /** A file that cannot be opened is skipped; many in a row end playback, so a missing folder is not an endless loop. */
  private async skip(): Promise<void> {
    if (++this.fails >= MAX_FAILS) throw new Error("Several tracks in a row could not be played, so playback stopped.");
    const r = await this.apply({ type: "failed" });
    if (!r.ok) throw new Error(r.text);
  }

  private async leaveSpotify(): Promise<void> {
    if (this.engine === "spotify" && this.deviceId) await this.d.spotify.control(this.deviceId, { action: "pause" }).catch(() => {});
    if (this.engine === "spotify") this.engine = null;
  }
  private async leaveFolder(): Promise<void> {
    if (this.engine === "folder") await this.d.mpv.stop().catch(() => {});
    if (this.engine === "folder") this.engine = null;
  }
  private async stopEngine(): Promise<void> {
    if (this.engine === "folder") await this.d.mpv.stop().catch(() => {});
    else if (this.engine === "spotify" && this.deviceId) await this.d.spotify.control(this.deviceId, { action: "pause" }).catch(() => {});
    this.engine = null;
  }
  private async pauseEngine(on: boolean): Promise<void> {
    if (this.engine === "folder") await this.d.mpv.pause(on);
    else if (this.engine === "spotify" && this.deviceId) await this.d.spotify.control(this.deviceId, { action: on ? "pause" : "resume" });
  }
  private async seekEngine(seconds: number): Promise<void> {
    if (this.engine === "folder") await this.d.mpv.seek(seconds);
    else if (this.engine === "spotify" && this.deviceId) await this.d.spotify.control(this.deviceId, { action: "seek", ms: Math.round(seconds * 1000) });
  }
  private async applyVolume(): Promise<void> {
    if (this.engine === "folder") {
      await this.d.mpv.volume(this.s.volume);
      await this.d.mpv.mute(this.s.muted);
    } else if (this.engine === "spotify" && this.deviceId) {
      await this.d.spotify.control(this.deviceId, { action: "volume", percent: this.s.muted ? 0 : this.s.volume });
    }
  }

  // ---- what the engines tell us ----

  private onMpv(e: MpvEvent): void {
    if (this.disposed) return;
    if (e.type === "time") {
      if (this.engine !== "folder") return;
      this.s = playerReducer(this.s, { type: "time", position: e.position, duration: e.duration });
      this.report(false);
    } else if (e.type === "ended") {
      if (this.engine === "folder") void this.run(() => this.apply({ type: "ended" }, true));
    } else if (e.type === "failed") {
      if (this.engine !== "folder") return;
      void this.run(async () => {
        // a SoundCloud address that ran out is asked for again, once per track, before the track is given up on
        const cur = this.s.queue[this.s.index];
        if (cur && this.loadedId === cur.id && cur.id.startsWith("soundcloud:") && this.retried !== cur.id) {
          this.retried = cur.id;
          const at = this.s.position;
          try {
            await this.load(cur);
            if (at > 1) await this.d.mpv.seek(at);
            return;
          } catch {
            /* falls through to the usual skip */
          }
        }
        if (++this.fails >= MAX_FAILS) {
          await this.apply({ type: "stop" });
          return this.fail("Several tracks in a row could not be played, so playback stopped.");
        }
        return this.apply({ type: "failed" }, true);
      });
    } else if (e.type === "exited") {
      void this.run(async () => {
        const wasPlaying = this.engine === "folder";
        this.loadedId = wasPlaying ? null : this.loadedId;
        if (!wasPlaying) return;
        this.engine = null;
        this.s = { ...this.s, playing: false };
        this.report(true);
        this.fail("mpv stopped unexpectedly. Play again to start it again.");
      });
    }
  }

  private syncPoll(): void {
    const need = this.engine === "spotify" && this.s.playing && !this.disposed;
    if (need && !this.poll) {
      this.pollFails = 0;
      // never queue a read behind one that has not come back
      this.poll = setInterval(() => {
        if (this.polling) return;
        this.polling = true;
        void this.run(() => this.pollOnce()).finally(() => (this.polling = false));
      }, POLL_MS);
    }
    else if (!need && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed || this.engine !== "spotify" || !this.s.playing) return;
    const cur = this.s.index >= 0 ? this.s.queue[this.s.index] : undefined;
    const id = cur ? parseRef(cur.id)?.id : undefined;
    let st: Awaited<ReturnType<HostDeps["spotify"]["playbackState"]>>;
    try {
      st = await this.d.spotify.playbackState();
    } catch (e) {
      const text = e instanceof Error ? e.message : "Spotify did not answer properly right now.";
      this.err = text;
      // a read that keeps failing ends playback with the sentence, instead of retrying for ever
      if (++this.pollFails >= 3) {
        await this.apply({ type: "stop" });
        this.fail(text);
      }
      return;
    }
    this.pollFails = 0;
    if (!id) return;
    if (st && st.trackId === id && st.playing) this.seen = true;
    const over = this.seen && (!st || st.trackId !== id || (!st.playing && st.positionMs < 1000 && this.lastPos > 1000));
    if (over) {
      await this.apply({ type: "ended" }, true);
      return;
    }
    if (!st || st.trackId !== id) return;
    this.lastPos = st.positionMs;
    this.s = playerReducer(this.s, { type: "time", position: st.positionMs / 1000, duration: st.durationMs / 1000 });
    if (!st.playing && this.seen && st.positionMs >= 1000) {
      await this.apply({ type: "pause" }, true); // paused on the device itself
      return;
    }
    this.report(false);
  }
}
