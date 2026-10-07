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
  /** Uploads one recording; resolves with what was heard. */
  post: (audio: Blob) => Promise<{ text: string }>;
  available: () => boolean;
  recorder?: Pick<Recorder, "active" | "start" | "stop" | "cancel" | "level">;
  player?: Pick<AudioPlayer, "playing" | "stop" | "unlock" | "enqueue" | "onChange" | "level">;
  supported?: () => boolean;
}

type ServerAudioMsg = { type: "audio.chunk" } & AudioChunk | { type: "audio.stop" };

/**
 * Push-to-talk, framework-free: press starts recording, release uploads it, replies play back
 * with barge-in. It mirrors its mode and live loudness into the store through `dispatch`.
 */
export class VoiceController {
  private recorder: NonNullable<VoiceDeps["recorder"]>;
  private player: NonNullable<VoiceDeps["player"]>;
  private mode: VoiceMode = "idle";
  private pressed = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: () => void;

  constructor(private deps: VoiceDeps) {
    this.recorder = deps.recorder ?? new Recorder({ maxMs: 60_000, onLimit: () => void this.pressEnd() });
    this.player = deps.player ?? new AudioPlayer();
    this.unsubscribe = this.player.onChange((playing) => {
      if (this.mode === "listening" || this.mode === "transcribing") return; // the owner's turn wins
      this.setMode(playing ? "speaking" : "idle");
    });
  }

  async pressStart(): Promise<void> {
    if (this.pressed) return; // key repeat
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
    try {
      const { text } = await this.deps.post(blob);
      if (!text.trim()) this.alert("info", "I didn't catch that.");
    } catch (e) {
      this.alert("error", (e as Error).message);
    } finally {
      this.setMode("idle");
    }
  }

  /** The window lost focus while the key was held: keep nothing, send nothing. */
  blur(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.recorder.cancel();
    this.setMode("idle");
  }

  handleServer(msg: ServerAudioMsg): void {
    if (msg.type === "audio.chunk") this.player.enqueue(msg);
    else this.player.stop();
  }

  dispose(): void {
    this.pressed = false;
    this.stopPolling();
    this.recorder.cancel();
    this.player.stop();
    this.unsubscribe();
  }

  private setMode(mode: VoiceMode): void {
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
    this.deps.dispatch({ type: "alert.add", level, text });
  }
}
