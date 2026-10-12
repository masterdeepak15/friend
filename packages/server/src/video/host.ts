import type { spawn } from "node:child_process";
import { Mpv, type FindResult } from "../music/mpv";
import type { VideoHostLike } from "./hub";

export interface VideoHostDeps {
  /** The mpv the owner set (empty: find it): the same setting the music player uses. */
  program: () => string;
  /** The yt-dlp mpv should use (a name or a path). */
  ytdlp: () => string;
  dataDir: string;
  spawn?: typeof spawn;
  /** For tests: stands in for finding mpv. */
  resolve?: () => Promise<FindResult>;
}

/**
 * A window on the PC that plays a video: the owner's mpv, with its own yt-dlp link, started with a window (the music player's mpv
 * has none). It is controlled through mpv's IPC, and the link goes through it, never on the command line.
 */
export class VideoHost implements VideoHostLike {
  private mpv: Mpv;

  constructor(private d: VideoHostDeps) {
    this.mpv = new Mpv({
      program: d.program,
      dataDir: d.dataDir,
      spawn: d.spawn,
      resolve: d.resolve,
      argv: (pipe) => {
        const ytdlp = d.ytdlp().trim();
        return [
          "--idle=yes",
          "--no-terminal",
          "--force-window=yes",
          "--keep-open=no",
          "--title=Friend video",
          "--ytdl=yes",
          "--ytdl-raw-options=ignore-config=,no-playlist=,socket-timeout=15",
          ...(ytdlp ? [`--script-opts=ytdl_hook-ytdl_path=${ytdlp}`] : []),
          "--load-scripts=no",
          "--access-references=no",
          "--tls-verify=yes",
          `--input-ipc-server=${pipe}`,
        ];
      },
    });
  }

  async open(url: string, o: { start: number; maxHeight: number }): Promise<{ ok: true } | { ok: false; error: string }> {
    const h = Math.round(o.maxHeight);
    try {
      await this.mpv.send(["set_property", "ytdl-format", `bv*[height<=${h}]+ba/b[height<=${h}]/b`]);
      await this.mpv.send(["set_property", "start", String(Math.max(0, Math.floor(o.start)))]);
      await this.mpv.load(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "mpv could not play that." };
    }
  }

  pause(on: boolean): Promise<void> {
    return this.mpv.pause(on);
  }
  seek(seconds: number): Promise<void> {
    return this.mpv.seek(seconds);
  }
  volume(percent: number): Promise<void> {
    return this.mpv.volume(percent);
  }
  stop(): Promise<void> {
    return this.mpv.stop();
  }

  dispose(): void {
    this.mpv.dispose();
  }
}
