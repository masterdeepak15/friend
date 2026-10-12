import { randomBytes } from "node:crypto";
import type { spawn } from "node:child_process";
import type { VideoOutput } from "@friend/protocol";
import type { Config } from "../config";
import { resolveVideo, type ResolveDeps, type VideoInfo, type YtRun } from "./resolve";
import { startStream, type StreamHandle } from "./stream";
import { videoStatus } from "./tools";
import type { VideoStatus } from "./types";

/** The window on the PC (mpv). It is its own piece so the hub can be tested without a real player. */
export interface VideoHostLike {
  open(url: string, o: { start: number; maxHeight: number }): Promise<{ ok: true } | { ok: false; error: string }>;
  pause(on: boolean): Promise<void>;
  seek(seconds: number): Promise<void>;
  volume(percent: number): Promise<void>;
  stop(): Promise<void>;
}

export interface VideoHubDeps {
  config: () => Pick<Config, "video" | "music">;
  /** Runs yt-dlp (tests). */
  run?: YtRun;
  /** Starts ffmpeg (tests). */
  spawn?: typeof spawn;
  /** Looks a name up for the address check (tests). */
  resolve?: ResolveDeps["resolve"];
  /** Looks for the helper programs (tests). */
  status?: () => Promise<VideoStatus>;
  host?: VideoHostLike;
  clock?: () => number;
}

export interface PlayArgs {
  url?: string;
  query?: string;
  output?: VideoOutput;
  start?: number;
}

export interface ControlArgs {
  action: "pause" | "resume" | "stop" | "seek" | "volume";
  seconds?: number;
  level?: number;
}

/** What the screen should show for a video: a card whose source is a Friend address, never the remote site. */
export interface ShowVideo {
  id: string;
  props: { title: string; src: string };
}

export type VideoResult = { ok: true; text: string; show?: ShowVideo; hide?: string } | { ok: false; text: string };

interface Token {
  info: VideoInfo;
  startSec: number;
  expires: number;
}

const CARD = "video-now";
const TTL_MS = 6 * 3600 * 1000;
const MAX_TOKENS = 20;
const MAX_STREAMS = 2;
const STATUS_MS = 60_000;
const TOKEN = /^[0-9a-f]{32}$/;

/**
 * Plays videos from the internet for the assistant. A video goes either to the Friend screen (yt-dlp finds it, ffmpeg turns it into
 * something the browser plays, and the screen asks Friend for it at an address only Friend made) or to a window on the PC (the
 * PC's mpv). Friend ships none of the programs; it only looks for them and says how to install what is missing.
 */
export class VideoHub {
  private tokens = new Map<string, Token>();
  private streams: { id: string; handle: StreamHandle }[] = [];
  private cached: { status: VideoStatus; at: number } | null = null;
  private now: { output: VideoOutput; title: string; uploader: string; info: VideoInfo } | null = null;

  constructor(private d: VideoHubDeps) {}

  private clock(): number {
    return (this.d.clock ?? Date.now)();
  }

  /** What was found last time it looked (null before the first look). */
  status(): VideoStatus | null {
    return this.cached?.status ?? null;
  }

  async refresh(): Promise<VideoStatus> {
    const status = await (this.d.status ?? (() => videoStatus(this.d.config())))();
    this.cached = { status, at: this.clock() };
    return status;
  }

  private async ensureStatus(): Promise<VideoStatus> {
    return this.cached && this.clock() - this.cached.at < STATUS_MS ? this.cached.status : this.refresh();
  }

  private issue(info: VideoInfo, startSec: number): ShowVideo {
    const now = this.clock();
    for (const [id, t] of this.tokens) if (t.expires <= now) this.tokens.delete(id);
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value as string);
    const id = randomBytes(16).toString("hex");
    this.tokens.set(id, { info, startSec, expires: now + TTL_MS });
    return { id: CARD, props: { title: info.title, src: `/api/video/${id}` } };
  }

  async play(args: PlayArgs): Promise<VideoResult> {
    const cfg = this.d.config().video;
    if (!cfg.installed || !cfg.enabled) return { ok: false, text: "Web video is not switched on. The owner can install and turn it on in Plugins, Web video." };
    const output: VideoOutput = args.output ?? cfg.output;
    const status = await this.ensureStatus();
    if (!status.ytdlp.found) return { ok: false, text: status.ytdlp.install ?? "yt-dlp is not found on this PC." };
    if (output === "screen" && !status.ffmpeg.found) return { ok: false, text: status.ffmpeg.install ?? "ffmpeg is not found on this PC." };
    if (output === "host" && !status.mpv.found) return { ok: false, text: status.mpv.install ?? "mpv is not found on this PC." };
    if (output === "host" && !this.d.host) return { ok: false, text: "Playing in a window on this PC is not available." };

    const r = await resolveVideo({ url: args.url, query: args.query }, { ytdlp: status.ytdlp.path ?? "yt-dlp", video: cfg, run: this.d.run, resolve: this.d.resolve });
    if (!r.ok) return { ok: false, text: r.error };
    const info = r.info;
    const start = typeof args.start === "number" && args.start > 0 ? Math.floor(args.start) : 0;
    const what = `"${info.title}"${info.uploader ? ` by ${info.uploader}` : ""}`;

    await this.stopEverything();
    if (output === "host") {
      const opened = await this.d.host!.open(info.webpage || args.url || "", { start, maxHeight: cfg.maxHeight });
      if (!opened.ok) return { ok: false, text: opened.error };
      this.now = { output, title: info.title, uploader: info.uploader, info };
      return { ok: true, text: `Playing ${what} in a window on this PC.` };
    }
    const show = this.issue(info, start);
    this.now = { output, title: info.title, uploader: info.uploader, info };
    return { ok: true, text: `Playing ${what} on your Friend screen.`, show };
  }

  /** The screen asks for the video at the address `play` gave it. Null when the address is not one Friend made, or is old. */
  async streamOf(id: string): Promise<StreamHandle | null> {
    if (!TOKEN.test(id)) return null;
    const t = this.tokens.get(id);
    if (!t || t.expires <= this.clock()) {
      this.tokens.delete(id);
      return null;
    }
    const status = await this.ensureStatus();
    const ffmpeg = status.ffmpeg.found ? status.ffmpeg.path : undefined;
    if (!ffmpeg) return null;
    while (this.streams.length >= MAX_STREAMS) this.streams.shift()!.handle.stop();
    const cfg = this.d.config().video;
    const handle = startStream(ffmpeg, t.info, { startSec: t.startSec, maxHeight: cfg.maxHeight, maxMinutes: cfg.maxMinutes }, { spawn: this.d.spawn });
    const entry = { id, handle };
    this.streams.push(entry);
    void handle.exited.then(() => {
      this.streams = this.streams.filter((s) => s !== entry);
    });
    return handle;
  }

  private async stopEverything(): Promise<void> {
    for (const s of this.streams.splice(0)) s.handle.stop();
    if (this.now?.output === "host") await this.d.host?.stop().catch(() => {});
    this.now = null;
  }

  async control(args: ControlArgs): Promise<VideoResult> {
    if (args.action === "stop") {
      const wasScreen = this.now?.output === "screen";
      await this.stopEverything();
      return { ok: true, text: "Stopped the video.", ...(wasScreen ? { hide: CARD } : {}) };
    }
    const now = this.now;
    if (!now) return { ok: false, text: "Nothing is playing." };
    if (now.output === "host") {
      const host = this.d.host!;
      try {
        if (args.action === "pause") await host.pause(true);
        else if (args.action === "resume") await host.pause(false);
        else if (args.action === "seek") await host.seek(Math.max(0, args.seconds ?? 0));
        else await host.volume(Math.max(0, Math.min(100, args.level ?? 50)));
      } catch (e) {
        return { ok: false, text: e instanceof Error ? e.message : "The player did not answer." };
      }
      return { ok: true, text: args.action === "seek" ? `Jumped to ${Math.round(args.seconds ?? 0)} seconds.` : args.action === "volume" ? `Volume ${Math.round(args.level ?? 50)}.` : args.action === "pause" ? "Paused." : "Playing again." };
    }
    // on the screen the video has its own buttons; only a jump to a time needs Friend, because the stream is made as it is watched
    if (args.action === "seek") {
      for (const s of this.streams.splice(0)) s.handle.stop();
      const show = this.issue(now.info, Math.max(0, Math.floor(args.seconds ?? 0)));
      return { ok: true, text: `Jumped to ${Math.round(args.seconds ?? 0)} seconds.`, show };
    }
    return { ok: true, text: "On the Friend screen the video has its own buttons for pause, play and volume: use those." };
  }

  nowPlaying(): string {
    const n = this.now;
    if (!n) return "Nothing is playing.";
    return `Playing "${n.title}"${n.uploader ? ` by ${n.uploader}` : ""} ${n.output === "host" ? "in a window on this PC" : "on the Friend screen"}.`;
  }

  /** What is found and what is missing, in words, for the assistant to pass on. */
  async check(): Promise<{ ok: true; text: string }> {
    const s = await this.refresh();
    const line = (name: string, h: VideoStatus[keyof VideoStatus], need: string) => (h.found ? `${name} ${h.version ?? ""} (found)`.replace("  ", " ") : `${name}: not found (${need}). ${h.install ?? ""}`.trim());
    return { ok: true, text: [line("yt-dlp", s.ytdlp, "needed for every video"), line("ffmpeg", s.ffmpeg, "needed to play on the Friend screen"), line("mpv", s.mpv, "needed to play in a window on this PC")].join("\n") };
  }

  dispose(): void {
    for (const s of this.streams.splice(0)) s.handle.stop();
    this.tokens.clear();
  }
}
