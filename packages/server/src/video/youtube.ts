import { sentenceFor, ytRun, type YtRun } from "./resolve";

/** A YouTube video id: eleven letters, digits, hyphens and underscores. */
export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"]);

/**
 * The id of the one video a YouTube link points to, or null (another site, a look-alike name, a playlist or a channel, a link with a
 * login or an odd port). The names are matched exactly, never by their ending, so youtube.com.evil.example is not YouTube.
 */
export function youtubeId(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(typeof raw === "string" ? raw.trim() : "");
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  let id: string | null = null;
  if (host === "youtu.be") id = first || null;
  else if (first === "watch") id = u.searchParams.get("v");
  else if (["shorts", "live", "embed", "v"].includes(first)) id = parts[1] ?? null;
  return id !== null && YOUTUBE_ID.test(id) ? id : null;
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The title and channel of a video from YouTube's own public title service: no program, no sign-in. A plain name when it does not answer. */
export async function titleOfYoutube(id: string, d: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<{ title: string; uploader: string; embeddable: boolean }> {
  const fallback = { title: "YouTube video", uploader: "", embeddable: true };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), d.timeoutMs ?? 5000);
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
    const res = await (d.fetch ?? fetch)(url, { signal: ctl.signal });
    // a video whose owner does not let it play on other sites is answered with 401 (or 403): it must not go in the embedded player
    if (res.status === 401 || res.status === 403) return { ...fallback, embeddable: false };
    if (!res.ok) return fallback;
    const j = (await res.json()) as { title?: unknown; author_name?: unknown };
    return { title: clean(j.title, 200) || fallback.title, uploader: clean(j.author_name, 100), embeddable: true };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

export type YoutubeFound = { ok: true; id: string; title: string; uploader: string; live: boolean } | { ok: false; error: string };

/** The first YouTube result for some words, asked of yt-dlp as a list only: nothing is fetched of the video itself. */
export async function searchYoutube(query: string, d: { ytdlp: string; run?: YtRun }): Promise<YoutubeFound> {
  const q = query.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  if (!q) return { ok: false, error: "Tell me what to play: a link to a video, or what to search for." };
  let res: Awaited<ReturnType<YtRun>>;
  try {
    res = await (d.run ?? ytRun)(d.ytdlp, ["--ignore-config", "--no-warnings", "--flat-playlist", "--skip-download", "--socket-timeout", "15", "-J", "--", `ytsearch1:${q}`], { timeoutMs: 30_000, maxBytes: 4_000_000 });
  } catch {
    return { ok: false, error: "Friend could not start yt-dlp." };
  }
  if (res.code !== 0) return { ok: false, error: sentenceFor(res.err) };
  let data: { entries?: { id?: unknown; title?: unknown; uploader?: unknown; channel?: unknown; is_live?: unknown }[] };
  try {
    data = JSON.parse(res.out);
  } catch {
    return { ok: false, error: "Friend could not get that video." };
  }
  const e = Array.isArray(data.entries) ? data.entries[0] : undefined;
  if (!e) return { ok: false, error: "Friend did not find a video for that." };
  if (typeof e.id !== "string" || !YOUTUBE_ID.test(e.id)) return { ok: false, error: "Friend did not find a video for that." };
  return { ok: true, id: e.id, title: clean(e.title, 200) || "YouTube video", uploader: clean(e.uploader ?? e.channel, 100), live: e.is_live === true };
}
