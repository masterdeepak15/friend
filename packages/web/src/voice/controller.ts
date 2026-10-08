import type { ClientMsg } from "@friend/protocol";
import type { LocalAction, VoiceMode } from "../store";
import { AudioPlayer, type AudioChunk } from "./player";
import { Recorder } from "./recorder";

/** Recordings shorter than this (about a fifth of a second) are accidental taps. */
const MIN_BYTES = 2000;
const LEVEL_POLL_MS = 50;

export interface VoiceDeps {
  send: (m: ClientMsg) => void;
  dispatch: (a: LocalAction) => void;
  /** Uploads one recording; resolves with what was heard. The signal aborts the upload. */
  post: (audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>;
  available: () => boolean;
  recorder?: Pick<Recorder, "active" | "start" | "stop" | "cancel" | "level">;
  /** Builds the recorder when none is injected; `onError` must be called if it fails on its own. */
  makeRecorder?: (onError: () => void) => NonNullable<VoiceDeps["recorder"]>;
  player?: Pick<AudioPlayer, "playing" | "stop" | "unlock" | "enqueue" | "onChange" | "level"> & { locked?: () => boolean; dispose?: () => void };
  supported?: () => boolean;
}

type ServerAudioMsg = ({ type: "audio.chunk" } & AudioChunk) | { type: "audio.stop" };

/**
 * Push-to-talk, framework-free: press starts recording, release uploads it, replies play back
 * with barge-in. It mirrors its mode and live loudness into the store through `dispatch`.
 */
export class VoiceController {
  private recorder: NonNullable<VoiceDeps["recorder"]>;
  private player: NonNullable<VoiceDeps["player"]>;
  private mode: VoiceMode = "idle";
  private pressed = false;
  private disposed = false;
  private uploads = 0;
  private toldAboutSound = false;
  private abort: AbortController | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: () => void;

  constructor(private deps: VoiceDeps) {
    const onError = () => this.recorderFailed();
    this.recorder =
      deps.recorder ??
      deps.makeRecorder?.(onError) ??
      new Recorder({ maxMs: 60_000, onLimit: () => void this.pressEnd(), onError });
    this.player = deps.player ?? new AudioPlayer();
    this.unsubscribe = this.player.onChange((playing) => {
      if (this.mode === "listening" || this.mode === "transcribing") return; // the owner's turn wins
      this.setMode(playing ? "speaking" : "idle");
    });
  }

  async pressStart(): Promise<void> {
    if (this.pressed || this.disposed) return; // key repeat
    if (!this.deps.available()) {
      this.alert("warn", "Voice is not available. Run: friend voice setup");
      return;
    }
    if (!(this.deps.supported?.() ?? Recorder.supported())) {
      this.alert("warn", "This browser cannot record audio here (use localhost or HTTPS).");
      return;
    }
    this.pressed = true;
    this.player.unlock(); // this key press is the user gesture that lets audio play later
    if (this.player.playing()) {
      this.deps.send({ type: "voice.interrupt" }); // barge-in
      this.player.stop();
    }
    try {
      await this.recorder.start();
    } catch (e) {
      this.pressed = false;
      this.alert("error", (e as Error).message);
      this.setMode("idle");
      return;
    }
    if (!this.pressed) {
      // released (or focus lost) while the microphone was still opening
      this.recorder.cancel();
      this.setMode("idle");
      return;
    }
    this.setMode("listening");
  }

  async pressEnd(): Promise<void> {
    if (!this.pressed) return;
    this.pressed = false;
    if (!this.recorder.active) return; // pressStart notices the release when the microphone finishes opening
    const blob = await this.recorder.stop();
    if (blob.size < MIN_BYTES) {
      this.alert("info", "Hold the key a little longer while you speak.");
      this.setMode("idle");
      return;
    }
    this.setMode("transcribing");
    const ac = new AbortController();
    this.abort = ac;
    this.uploads++;
    try {
      const { text } = await this.deps.post(blob, ac.signal);
      if (!text.trim()) this.alert("info", "I didn't catch that.");
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.alert("error", (e as Error).message);
    } finally {
      this.uploads--;
      if (this.abort === ac) this.abort = null;
      this.settle();
    }
  }

  /** The window lost focus, or the press was cancelled: keep nothing, send nothing. */
  blur(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.recorder.cancel();
    this.setMode("idle");
  }

  handleServer(msg: ServerAudioMsg): void {
    if (msg.type !== "audio.chunk") return this.player.stop();
    this.player.enqueue(msg); // it plays as soon as the browser allows sound
    if (!this.toldAboutSound && this.player.locked?.()) {
      this.toldAboutSound = true;
      this.deps.dispatch({ type: "alert.add", level: "info", text: "Sound is blocked by the browser. Click or press a key once anywhere on the page to hear me." });
    }
  }

  /** A click or key press happened somewhere on the page: the browser now allows sound. */
  unlock(): void {
    this.player.unlock();
  }

  dispose(): void {
    this.disposed = true;
    this.pressed = false;
    this.stopPolling();
    this.abort?.abort();
    this.recorder.cancel();
    this.player.stop();
    this.player.dispose?.();
    this.unsubscribe();
  }

  /** The recorder broke by itself (device unplugged, permission revoked). It has already released the microphone. */
  private recorderFailed(): void {
    this.pressed = false;
    this.recorder.cancel();
    this.alert("error", "The microphone stopped working.");
    this.setMode("idle");
  }

  /** After an upload finishes: leave "transcribing" only if nothing newer (a new recording) took over. */
  private settle(): void {
    if (this.uploads > 0 || this.mode !== "transcribing") return;
    this.setMode(this.player.playing() ? "speaking" : "idle");
  }

  private setMode(mode: VoiceMode): void {
    if (this.disposed) return;
    this.mode = mode;
    this.deps.dispatch({ type: "voice.mode", mode });
    if (mode === "listening" || mode === "speaking") this.startPolling();
    else this.stopPolling();
  }

  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => {
      const level = this.mode === "listening" ? this.recorder.level() : this.player.level();
      this.deps.dispatch({ type: "voice.level", level });
    }, LEVEL_POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private alert(level: "info" | "warn" | "error", text: string): void {
    if (this.disposed) return;
    this.deps.dispatch({ type: "alert.add", level, text });
  }
}
