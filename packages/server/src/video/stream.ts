import { spawn as nodeSpawn } from "node:child_process";
import { PassThrough, type Readable } from "node:stream";
import type { VideoInfo } from "./resolve";

export interface StreamOptions {
  /** Where to begin, in seconds. */
  startSec: number;
  /** The tallest picture, in pixels (used when the picture has to be converted). */
  maxHeight: number;
  /** The most it will play, in minutes, so nothing runs forever. */
  maxMinutes: number;
}

/**
 * The ffmpeg command that turns what yt-dlp found into a fragmented MP4 a browser can play as it arrives. The picture and the sound
 * are copied when they are already H.264 and AAC (cheap), and converted when they are not. Only web addresses may be read.
 */
export function ffmpegArgs(info: VideoInfo, o: StreamOptions): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  for (const input of info.inputs) {
    const lines = Object.entries(input.headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
    if (lines) args.push("-headers", lines);
    args.push("-protocol_whitelist", "http,https,tcp,tls,crypto");
    if (o.startSec > 0) args.push("-ss", String(Math.floor(o.startSec)));
    args.push("-i", input.url);
  }
  const vi = Math.max(0, info.inputs.findIndex((i) => i.kind !== "audio"));
  const separateAudio = info.inputs.findIndex((i) => i.kind === "audio");
  if (separateAudio >= 0) args.push("-map", `${vi}:v:0`, "-map", `${separateAudio}:a:0`);
  else args.push("-map", `${vi}:v:0`, "-map", `${vi}:a:0?`);
  if (info.transcodeVideo) args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-vf", `scale=-2:'min(ih,${Math.round(o.maxHeight)})'`);
  else args.push("-c:v", "copy");
  if (info.transcodeAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  else args.push("-c:a", "copy");
  args.push("-max_muxing_queue_size", "1024", "-t", String(Math.round(o.maxMinutes * 60)), "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  return args;
}

export interface StreamHandle {
  /** The video as it is made. It ends with an error if ffmpeg fails. */
  stream: Readable;
  /** Ends ffmpeg (once; asking again does nothing). */
  stop(): void;
  /** The exit code of ffmpeg, when it is over. */
  exited: Promise<number>;
}

export interface StreamDeps {
  spawn?: typeof nodeSpawn;
}

/** Starts ffmpeg for one viewer. The caller must call `stop()` when the viewer leaves. */
export function startStream(ffmpeg: string, info: VideoInfo, o: StreamOptions, d: StreamDeps = {}): StreamHandle {
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = (d.spawn ?? nodeSpawn)(ffmpeg, ffmpegArgs(info, o), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch {
    throw new Error("Friend could not start ffmpeg.");
  }
  const stream = new PassThrough();
  let stopped = false;
  let tail = "";
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.on("data", (d: Buffer) => {
    tail = (tail + d.toString("utf8")).slice(-500);
  });
  const exited = new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      const c = code ?? -1;
      if (stopped || c === 0 || code === null) stream.end();
      else stream.destroy(new Error(`ffmpeg stopped: ${tail.trim().split(/\r?\n/).pop() ?? ""}`.slice(0, 200)));
      resolve(c);
    };
    child.on("close", finish);
    child.on("error", () => finish(-1));
  });
  return {
    stream,
    exited,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
