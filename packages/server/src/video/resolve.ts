import { spawn } from "node:child_process";
import type { VideoConfig } from "../config";
import { vetVideoUrl, type VetDeps } from "./url";

export type YtRun = (cmd: string, args: string[], opts?: { timeoutMs?: number; maxBytes?: number }) => Promise<{ code: number; out: string; err: string }>;

/** One address ffmpeg reads: the picture, the sound, or both together, with the request headers the site wants. */
export interface StreamInput {
  url: string;
  kind: "video" | "audio" | "both";
  headers: Record<string, string>;
}

export interface VideoInfo {
  id: string;
  title: string;
  uploader: string;
  durationSec: number | null;
  webpage: string;
  live: boolean;
  inputs: StreamInput[];
  /** The picture is not H.264 and has to be converted for the browser. */
  transcodeVideo: boolean;
  /** The sound is not AAC and has to be converted for the browser. */
  transcodeAudio: boolean;
}

export type Resolved = { ok: true; info: VideoInfo } | { ok: false; error: string };

export interface ResolveDeps {
  /** The yt-dlp program (a name or a path). */
  ytdlp: string;
  video: Pick<VideoConfig, "maxHeight" | "maxMinutes" | "allowedSites">;
  run?: YtRun;
  resolve?: VetDeps["resolve"];
}

/** Runs yt-dlp. Its output is capped and it is stopped after a while; a program that cannot start is an error, not a result. */
export const ytRun: YtRun = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const maxBytes = opts.maxBytes ?? 8_000_000;
    let out = "";
    let err = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const timer = setTimeout(() => {
      child.kill();
      err += "timed out";
      finish(-1);
    }, opts.timeoutMs ?? 45_000);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > maxBytes) {
        child.kill();
        finish(-1);
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (err.length < 4000) err += d.toString("utf8");
    });
    child.on("error", (e) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => finish(code ?? -1));
  });

const NOT_ALLOWED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "expect"]);

/** Only plain request headers: a name of letters, digits and hyphens, a one-line value. Anything that could carry a second line is dropped. */
function cleanHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 20) break;
    if (typeof v !== "string" || v.length > 500 || !/^[A-Za-z0-9-]{1,50}$/.test(k) || NOT_ALLOWED_HEADERS.has(k.toLowerCase())) continue;
    if (/[\u0000-\u001f\u007f]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** What went wrong, in one plain sentence. yt-dlp's own words can hold addresses and paths, so they are never passed on. */
export function sentenceFor(stderr: string): string {
  const t = stderr.toLowerCase();
  if (/unsupported url/.test(t)) return "Friend cannot find a video on that page.";
  if (/\b429\b|too many requests/.test(t)) return "The site is asking Friend to slow down. Try again in a minute.";
  if (/unavailable|private|removed|deleted|not available|sign in|log in|login|confirm you|members-only|geo|region|age-restricted|copyright|blocked/.test(t)) return "That video is not available (private, removed, restricted in your region or age, or it needs a login).";
  if (/timed out|timeout|temporary failure|name or service|unable to download webpage|connection|network/.test(t)) return "The site did not answer in time.";
  return "Friend could not get that video.";
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const codec = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "none");
const isH264 = (c: string) => c.startsWith("avc1") || c.startsWith("h264");
const isAac = (c: string) => c.startsWith("mp4a") || c.startsWith("aac");

/**
 * Finds the real video behind a link (or a search on YouTube) with yt-dlp, and checks every address on the way: the link before
 * yt-dlp starts, and each media address it found before ffmpeg or mpv is ever pointed at it.
 */
export async function resolveVideo(input: { url?: string; query?: string }, d: ResolveDeps): Promise<Resolved> {
  const run = d.run ?? ytRun;
  const vetDeps: VetDeps = { allowedSites: d.video.allowedSites, ...(d.resolve ? { resolve: d.resolve } : {}) };
  let target: string;
  if (input.url && input.url.trim()) {
    const v = await vetVideoUrl(input.url, vetDeps);
    if (!v.ok) return { ok: false, error: v.error };
    target = v.url;
  } else if (input.query && input.query.trim()) {
    const sites = d.video.allowedSites;
    if (sites.length && !sites.some((s) => s === "youtube.com" || s.endsWith(".youtube.com"))) return { ok: false, error: `A search uses YouTube, which is not on your allowed list (${sites.join(", ")}).` };
    target = `ytsearch1:${input.query.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200)}`;
  } else {
    return { ok: false, error: "Tell me what to play: a link to a video, or what to search for." };
  }

  const h = d.video.maxHeight;
  const args = [
    "--ignore-config",
    "--no-warnings",
    "--no-playlist",
    "--skip-download",
    "--no-cache-dir",
    "--socket-timeout",
    "15",
    "-f",
    `bv*[height<=${h}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
    "-J",
    "--",
    target,
  ];
  let res: Awaited<ReturnType<YtRun>>;
  try {
    res = await run(d.ytdlp, args, { timeoutMs: 45_000, maxBytes: 8_000_000 });
  } catch {
    return { ok: false, error: "Friend could not start yt-dlp." };
  }
  if (res.code !== 0) return { ok: false, error: sentenceFor(res.err) };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(res.out) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Friend could not get that video." };
  }
  const entries = Array.isArray(data.entries) ? (data.entries as Record<string, unknown>[]) : null;
  const e = entries ? entries.find((x) => x && typeof x === "object") : data;
  if (!e) return { ok: false, error: "Friend did not find a video for that." };

  const duration = typeof e.duration === "number" && Number.isFinite(e.duration) ? Math.round(e.duration) : null;
  const live = e.is_live === true;
  if (duration !== null && duration > d.video.maxMinutes * 60) return { ok: false, error: `That video is longer than the limit you set (${d.video.maxMinutes} minutes).` };

  const parts = Array.isArray(e.requested_formats) && e.requested_formats.length ? (e.requested_formats as Record<string, unknown>[]) : [e];
  const inputs: StreamInput[] = [];
  let vcodec = "none";
  let acodec = "none";
  for (const f of parts.slice(0, 2)) {
    const url = typeof f.url === "string" ? f.url : "";
    const ok = await vetVideoUrl(url, { ...vetDeps, ignoreSites: true });
    if (!ok.ok) return { ok: false, error: ok.error };
    const vc = codec(f.vcodec);
    const ac = codec(f.acodec);
    const kind: StreamInput["kind"] = vc !== "none" && ac !== "none" ? "both" : vc !== "none" ? "video" : "audio";
    if (vc !== "none") vcodec = vc;
    if (ac !== "none") acodec = ac;
    inputs.push({ url: ok.url, kind, headers: cleanHeaders(f.http_headers) });
  }
  if (!inputs.some((i) => i.kind !== "audio")) return { ok: false, error: "That link has no video in it." };

  const id = text(e.id, 80) || "video";
  return {
    ok: true,
    info: {
      id,
      title: text(e.title, 200) || "Video",
      uploader: text(e.uploader ?? e.channel, 100),
      durationSec: duration,
      webpage: typeof e.webpage_url === "string" && /^https?:\/\//.test(e.webpage_url) ? e.webpage_url : typeof input.url === "string" ? input.url.trim() : "",
      live,
      inputs,
      transcodeVideo: !isH264(vcodec),
      transcodeAudio: acodec === "none" ? false : !isAac(acodec),
    },
  };
}
