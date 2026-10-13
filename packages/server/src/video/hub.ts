import { randomBytes } from "node:crypto";
import type { spawn } from "node:child_process";
import type { VideoOutput, VideoYoutube } from "@friend/protocol";
import type { Config } from "../config";
import { resolveVideo, type ResolveDeps, type VideoInfo, type YtRun } from "./resolve";
import type { Provisioner, ToolName } from "./provision";
import { startStream, type StreamHandle } from "./stream";
import { videoStatus, type FindHelperDeps } from "./tools";
import { searchYoutube, titleOfYoutube, youtubeId } from "./youtube";
import { vetVideoUrl } from "./url";
import type { HelperStatus, VideoStatus } from "./types";

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
  /** Friend's data folder: the programs it downloaded are in its tools folder, and are looked for first. */
  dataDir?: string;
  /** How the programs are looked for (tests). */
  find?: Omit<FindHelperDeps, "program" | "managed">;
  host?: VideoHostLike;
  clock?: () => number;
  /** Downloads yt-dlp and ffmpeg when they are missing. Without it nothing is downloaded. */
  provisioner?: Pick<Provisioner, "ensure" | "state"> & Partial<Pick<Provisioner, "update">>;
  /** How long a request waits for a download before it says it is still going (default 25 seconds). */
  waitMs?: number;
  /** For YouTube's title service (tests). */
  fetch?: typeof fetch;
  /** The address a browser on this PC can use to watch a video (Friend's own, with a ticket). */
  windowUrl?: (id: string, ticket: string) => string;
  /** Opens an address in the PC's browser. */
  openBrowser?: (url: string) => Promise<boolean>;
}

export interface PlayArgs {
  url?: string;
  query?: string;
  output?: VideoOutput;
  start?: number;
  /** How a YouTube video plays on the screen for this request (the owner's setting otherwise). */
  mode?: VideoYoutube;
}

export interface ControlArgs {
  action: "pause" | "resume" | "stop" | "seek" | "volume";
  seconds?: number;
  level?: number;
}

/** What the screen should show for a video: a card whose source is a Friend address, never the remote site. */
export interface ShowVideo {
  id: string;
  /** Either src (a Friend address, for a video Friend makes) or embed (a YouTube video id, for YouTube's own player). */
  props: { title: string; src?: string; embed?: string; start?: number };
}

export type VideoResult = { ok: true; text: string; show?: ShowVideo; hide?: string } | { ok: false; text: string };

interface Token {
  info: VideoInfo;
  startSec: number;
  expires: number;
}

const TICKET_MS = 10 * 60 * 1000;

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
  private now: { output: VideoOutput; title: string; uploader: string; info?: VideoInfo; embed?: string; via?: "mpv" | "browser" } | null = null;
  private tickets = new Map<string, { id: string; expires: number }>();

  constructor(private d: VideoHubDeps) {}

  private clock(): number {
    return (this.d.clock ?? Date.now)();
  }

  /** What was found last time it looked (null before the first look), with how the download of the programs is going. */
  status(): VideoStatus | null {
    return this.cached ? { ...this.cached.status, setup: this.setup() } : null;
  }

  private setup(): NonNullable<VideoStatus["setup"]> {
    const st = this.d.provisioner?.state();
    if (!st) return { busy: false, message: null, error: null };
    const entries = Object.entries(st.tools) as [ToolName, { phase: string; percent?: number | null; error?: string }][];
    const active = entries.find(([, t]) => t.phase === "downloading" || t.phase === "unpacking");
    const message = active ? (active[1].phase === "unpacking" ? `Unpacking ${active[0]}…` : `Downloading ${active[0]}${typeof active[1].percent === "number" ? ` ${active[1].percent}%` : ""}…`) : null;
    const failed = entries.find(([, t]) => t.phase === "error");
    return { busy: st.busy, message, error: failed?.[1].error ?? null };
  }

  /**
   * The helper programs the chosen place to play needs: yt-dlp always; ffmpeg for the screen and for a browser window on the PC;
   * a window of mpv needs no ffmpeg. mpv itself is the owner's: when it is not there a browser window is used instead.
   */
  private wanted(output: VideoOutput, status: VideoStatus | null): ToolName[] {
    const mpvWindow = output === "host" && (status?.mpv.found ?? false) && !!this.d.host;
    return mpvWindow ? ["yt-dlp"] : ["yt-dlp", "ffmpeg"];
  }

  /** Whether a browser on this PC may watch this video without signing in: only with the ticket Friend made for it, and only for a while. */
  ticketOk(id: string, ticket: string): boolean {
    if (!TOKEN.test(id) || !TOKEN.test(ticket)) return false;
    const t = this.tickets.get(ticket);
    if (!t || t.id !== id || t.expires <= this.clock()) return false;
    return this.tokens.has(id);
  }

  private missing(status: VideoStatus, names: ToolName[]): ToolName[] {
    return names.filter((n) => !(n === "yt-dlp" ? status.ytdlp : status.ffmpeg).found);
  }

  /** Downloads what the plugin needs (if the owner allows it) and looks again. Called when the plugin is installed or switched on. */
  async prepare(): Promise<void> {
    const cfg = this.d.config().video;
    const status = await this.ensureStatus();
    const need = this.missing(status, this.wanted(cfg.output, status));
    if (need.length && cfg.autoInstall && this.d.provisioner) await this.d.provisioner.ensure(need);
    await this.refresh();
    if (cfg.autoInstall) void this.d.provisioner?.update?.().catch(() => {}); // a week-old yt-dlp is asked to update itself
  }

  async refresh(): Promise<VideoStatus> {
    const status = await (this.d.status ?? (() => videoStatus(this.d.config(), { ...this.d.find, dataDir: this.d.dataDir })))();
    this.cached = { status, at: this.clock() };
    return status;
  }

  private looking = false;

  /** Looks again for the helper programs in the background when the last look is old, so the plugin page stays true. */
  poke(maxAgeMs = 15_000): void {
    if (this.looking || (this.cached && this.clock() - this.cached.at < maxAgeMs)) return;
    this.looking = true;
    void this.refresh()
      .catch(() => {})
      .finally(() => {
        this.looking = false;
      });
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

  /** Fetches what is missing (when the owner allows it), waiting a while, then says it is still going. */
  private async ensureTools(need: ToolName[], cfg: Config["video"]): Promise<{ ok: true; status: VideoStatus } | { ok: false; text: string }> {
    const status = await this.ensureStatus();
    if (!need.length || !cfg.autoInstall || !this.d.provisioner) return { ok: true, status };
    // the programs are fetched by Friend itself; a big download is carried on in the background if it takes long
    const job = this.d.provisioner.ensure(need);
    const first = await Promise.race([job.then((r) => ({ r })), new Promise<{ slow: true }>((res) => setTimeout(() => res({ slow: true }), this.d.waitMs ?? 25_000))]);
    if ("slow" in first) {
      void job.then(() => this.refresh()).catch(() => {});
      return { ok: false, text: "Friend is downloading the video tools it needs (first time only, it can take a minute or two). Ask again in a minute." };
    }
    if (!first.r.ok) return { ok: false, text: first.r.error };
    return { ok: true, status: await this.refresh() };
  }

  /** A YouTube video in YouTube's own player, inside the card. A link needs nothing; a search needs yt-dlp, for the list of results only. */
  private async playEmbedded(args: PlayArgs, linkId: string | null, cfg: Config["video"]): Promise<VideoResult | null> {
    const start = typeof args.start === "number" && args.start > 0 ? Math.floor(args.start) : 0;
    let id: string;
    let title: string;
    let uploader: string;
    if (linkId) {
      const v = await vetVideoUrl(args.url!, { allowedSites: cfg.allowedSites, ...(this.d.resolve ? { resolve: this.d.resolve } : {}) });
      if (!v.ok) return { ok: false, text: v.error };
      id = linkId;
      const t = await titleOfYoutube(id, { fetch: this.d.fetch });
      if (!t.embeddable) return null;
      ({ title, uploader } = t);
    } else {
      const sites = cfg.allowedSites;
      if (sites.length && !sites.some((s) => s === "youtube.com" || s.endsWith(".youtube.com"))) return { ok: false, text: `A search uses YouTube, which is not on your allowed list (${sites.join(", ")}).` };
      const status0 = await this.ensureStatus();
      const got = await this.ensureTools(this.missing(status0, ["yt-dlp"]), cfg);
      if (!got.ok) return got;
      if (!got.status.ytdlp.found) return { ok: false, text: got.status.ytdlp.install ?? "yt-dlp is not found on this PC." };
      const found = await searchYoutube(args.query!, { ytdlp: got.status.ytdlp.path ?? "yt-dlp", run: this.d.run });
      if (!found.ok) return { ok: false, text: found.error };
      ({ id, title, uploader } = found);
    }
    await this.stopEverything();
    this.now = { output: "screen", title, uploader, embed: id };
    return { ok: true, text: `Playing "${title}"${uploader ? ` by ${uploader}` : ""} on your Friend screen.`, show: { id: CARD, props: { title, embed: id, ...(start > 0 ? { start } : {}) } } };
  }

  async play(args: PlayArgs): Promise<VideoResult> {
    const cfg = this.d.config().video;
    if (!cfg.installed || !cfg.enabled) return { ok: false, text: "Web video is not switched on. The owner can install and turn it on in Plugins, Web video." };
    const output: VideoOutput = args.output ?? cfg.output;
    // a YouTube video on the screen plays in YouTube's own player: no download, no ffmpeg (a link needs no program at all)
    if (output === "screen" && (args.mode ?? cfg.youtube) === "embed") {
      const ytId = args.url ? youtubeId(args.url) : null;
      if (ytId || (!args.url && args.query && args.query.trim())) {
        const emb = await this.playEmbedded(args, ytId, cfg);
        if (emb) return emb; // null: the owner of that video does not let it play on other sites, so it goes through Friend
      }
    }
    let status = await this.ensureStatus();
    const got = await this.ensureTools(this.missing(status, this.wanted(output, status)), cfg);
    if (!got.ok) return got;
    status = got.status;
    if (!status.ytdlp.found) return { ok: false, text: status.ytdlp.install ?? "yt-dlp is not found on this PC." };
    const mpvWindow = output === "host" && status.mpv.found && !!this.d.host;
    const browserWindow = output === "host" && !mpvWindow && !!this.d.openBrowser && !!this.d.windowUrl;
    if ((output === "screen" || browserWindow) && !status.ffmpeg.found) return { ok: false, text: status.ffmpeg.install ?? "ffmpeg is not found on this PC." };
    if (output === "host" && !mpvWindow && !browserWindow) return { ok: false, text: status.mpv.found ? "Playing in a window on this PC is not available." : (status.mpv.install ?? "mpv is not found on this PC.") };

    const r = await resolveVideo({ url: args.url, query: args.query }, { ytdlp: status.ytdlp.path ?? "yt-dlp", video: cfg, run: this.d.run, resolve: this.d.resolve });
    if (!r.ok) return { ok: false, text: r.error };
    const info = r.info;
    const start = typeof args.start === "number" && args.start > 0 ? Math.floor(args.start) : 0;
    const what = `"${info.title}"${info.uploader ? ` by ${info.uploader}` : ""}`;

    await this.stopEverything();
    if (mpvWindow) {
      const opened = await this.d.host!.open(info.webpage || args.url || "", { start, maxHeight: cfg.maxHeight });
      if (!opened.ok) return { ok: false, text: opened.error };
      this.now = { output, title: info.title, uploader: info.uploader, info, via: "mpv" };
      return { ok: true, text: `Playing ${what} in a window on this PC.` };
    }
    if (browserWindow) {
      const show = this.issue(info, start);
      const id = /\/api\/video\/([0-9a-f]{32})$/.exec(show.props.src!)![1]!;
      const ticket = randomBytes(16).toString("hex");
      this.tickets.set(ticket, { id, expires: this.clock() + TICKET_MS });
      const ok = await this.d.openBrowser!(this.d.windowUrl!(id, ticket)).catch(() => false);
      if (!ok) return { ok: false, text: "Friend could not open a browser window on this PC." };
      this.now = { output, title: info.title, uploader: info.uploader, info, via: "browser" };
      return { ok: true, text: `Playing ${what} in a browser window on this PC.` };
    }
    const show = this.issue(info, start);
    this.now = { output, title: info.title, uploader: info.uploader, info };
    return { ok: true, text: `Playing ${what} on your Friend screen.`, show };
  }

  /** The screen asks for the video at the address `play` gave it. Null when the address is not one Friend made, or is old. */
  async streamOf(id: string): Promise<StreamHandle | null> {
    if (!TOKEN.test(id)) return null;
    const cfg = this.d.config().video;
    if (!cfg.installed || !cfg.enabled) return null; // switched off: an address made a moment ago stops working too
    const t = this.tokens.get(id);
    if (!t || t.expires <= this.clock()) {
      this.tokens.delete(id);
      return null;
    }
    const status = await this.ensureStatus();
    const ffmpeg = status.ffmpeg.found ? status.ffmpeg.path : undefined;
    if (!ffmpeg) return null;
    while (this.streams.length >= MAX_STREAMS) this.streams.shift()!.handle.stop();
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
    if (now.output === "host" && now.via === "browser") return { ok: true, text: "The video is in a browser window on this PC: use the player in the browser window for pause, play, volume and the time." };
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
      const at = Math.max(0, Math.floor(args.seconds ?? 0));
      if (now.embed) {
        // YouTube's own player starts again from that time
        return { ok: true, text: `Jumped to ${Math.round(args.seconds ?? 0)} seconds.`, show: { id: CARD, props: { title: now.title, embed: now.embed, ...(at > 0 ? { start: at } : {}) } } };
      }
      for (const s of this.streams.splice(0)) s.handle.stop();
      const show = this.issue(now.info!, at);
      return { ok: true, text: `Jumped to ${Math.round(args.seconds ?? 0)} seconds.`, show };
    }
    return { ok: true, text: "On the Friend screen the video has its own buttons for pause, play and volume: use those." };
  }

  nowPlaying(): string {
    const n = this.now;
    if (!n) return "Nothing is playing.";
    return `Playing "${n.title}"${n.uploader ? ` by ${n.uploader}` : ""} ${n.output === "host" ? (n.via === "browser" ? "in a browser window on this PC" : "in a window on this PC") : "on the Friend screen"}.`;
  }

  /** What is found and what is missing, in words, for the assistant to pass on. */
  async check(): Promise<{ ok: true; text: string }> {
    const s = await this.refresh();
    const line = (name: string, h: HelperStatus, need: string) => (h.found ? `${name} ${h.version ?? ""} (found)`.replace("  ", " ") : `${name}: not found (${need}). ${h.install ?? ""}`.trim());
    return { ok: true, text: [line("yt-dlp", s.ytdlp, "needed for every video"), line("ffmpeg", s.ffmpeg, "needed to play on the Friend screen"), line("mpv", s.mpv, "needed to play in a window on this PC")].join("\n") };
  }

  dispose(): void {
    for (const s of this.streams.splice(0)) s.handle.stop();
    this.tokens.clear();
  }
}
