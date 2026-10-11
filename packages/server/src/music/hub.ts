import type { MusicCommand, MusicState, MusicTrackRef, ServerMsg } from "@friend/protocol";
import { parseRef } from "@friend/protocol";
import type { MusicLibrary, PublicTrack } from "./library";
import type { MusicSources, SourceTrack } from "./source";

export interface MusicConn {
  send(m: ServerMsg): void;
}
export interface Result {
  ok: boolean;
  text: string;
}

const NO_SCREEN = "No Friend screen is open, so there is nowhere to play music. Open Friend on a screen first.";
const MAX_SEND = 200;
const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const ref = (t: PublicTrack): MusicTrackRef => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec });
/** A track as the screen needs it. A file in the folder keeps its bare id; any other source's track is addressed by its ref. */
const refOfSource = (t: SourceTrack): MusicTrackRef => ({ id: t.source === "local" ? (parseRef(t.ref)?.id ?? t.ref) : t.ref, title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec });
const label = (t: { title: string; artist: string }): string => (t.artist ? `${t.title} by ${t.artist}` : t.title);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export interface PlayArgs {
  query?: string;
  artist?: string;
  album?: string;
  title?: string;
  shuffle?: boolean;
  mode?: "replace" | "add" | "next";
  limit?: number;
  /** Where to look: the music folder, Spotify or both. Left out, the owner's default. */
  source?: "local" | "spotify" | "any";
}
export interface ControlArgs {
  action: string;
  level?: number;
  delta?: number;
  seconds?: number;
  percent?: number;
  on?: boolean;
  mode?: string;
  view?: string;
}
export interface QueueArgs {
  action: "add" | "remove" | "clear" | "show";
  query?: string;
  index?: number;
  source?: "local" | "spotify" | "any";
}

/**
 * Between the assistant and the music player on the owner's screen. The player lives in the browser; this finds the screen that
 * should play (the active one, or the newest), sends it commands, and remembers what it last said about itself.
 */
export class MusicHub {
  private conns = new Map<MusicConn, { state: MusicState | null; at: number; order: number }>();
  private order = 0;

  constructor(private d: { library: MusicLibrary; sources?: MusicSources }) {}

  private defaultSource(): "local" | "spotify" | "any" {
    return this.d.sources?.defaultSource() ?? "local";
  }

  attach(c: MusicConn): void {
    this.conns.set(c, { state: null, at: 0, order: ++this.order });
  }
  detach(c: MusicConn): void {
    this.conns.delete(c);
  }
  onState(c: MusicConn, state: MusicState, at = Date.now()): void {
    const e = this.conns.get(c);
    if (e) {
      e.state = state;
      e.at = at;
    }
  }

  /** The screen that plays: the active one that spoke last, else any that has spoken, else the newest connection. */
  private target(): { conn: MusicConn; state: MusicState | null } | null {
    const all = [...this.conns.entries()];
    if (!all.length) return null;
    const best = (rows: typeof all, by: (e: (typeof all)[number][1]) => number) => rows.reduce((a, b) => (by(b[1]) > by(a[1]) ? b : a));
    const active = all.filter(([, e]) => e.state?.active);
    const spoke = all.filter(([, e]) => e.state);
    const pick = active.length ? best(active, (e) => e.at) : spoke.length ? best(spoke, (e) => e.at) : best(all, (e) => e.order);
    return { conn: pick[0], state: pick[1].state };
  }

  private send(command: MusicCommand): Result | null {
    const t = this.target();
    if (!t) return { ok: false, text: NO_SCREEN };
    t.conn.send({ type: "music.command", ...command });
    return null;
  }

  private emptyReason(): string {
    return this.d.library.stats().folderSet ? "The music library is empty or still being read." : "No music folder is set. The owner chooses one in Settings, Widgets.";
  }

  async play(a: PlayArgs): Promise<Result> {
    const words = [a.query, a.title, a.artist, a.album].filter((w): w is string => typeof w === "string" && w.trim() !== "").join(" ");
    // "play my music" with no words is the folder, whatever the default source is; only a named service needs a word to search for
    if (!words) return a.source === "spotify" ? { ok: false, text: "Say what to play from Spotify: a song, an artist or a playlist." } : this.playLocal(a, words);
    const source = a.source ?? this.defaultSource();
    return source === "local" ? this.playLocal(a, words) : this.playFrom(a, words, source);
  }

  /** Play from a connected service (alone or together with the folder). What cannot be played is left out and said so. */
  private async playFrom(a: PlayArgs, words: string, source: "spotify" | "any"): Promise<Result> {
    const sources = this.d.sources;
    if (!sources) return { ok: false, text: "Other music sources are not available." };
    const found = await sources.search(words, { source, ...(a.limit ? { limit: a.limit } : {}) });
    const notes = [...found.notes];
    const sp = sources.status().spotify;
    let tracks = found.tracks;
    if (sp?.connected && sp.canPlay === false) {
      const kept = tracks.filter((t) => t.source !== "spotify");
      if (kept.length < tracks.length && sp.needs) notes.push(sp.needs);
      tracks = kept;
    }
    if (!tracks.length) return { ok: false, text: notes.length ? notes.join(" ") : `No music matches "${words}".` };
    const mode = a.mode ?? "replace";
    const failed = this.send({ action: "play", tracks: tracks.map(refOfSource), mode, ...(a.shuffle ? { shuffle: true } : {}) });
    if (failed) return failed;
    const n = tracks.length;
    const first = tracks[0]!;
    const base = mode === "add" ? `Added ${plural(n, "track")} to the queue.` : mode === "next" ? `Queued ${plural(n, "track")} to play next, starting with ${label(first)}.` : `Playing ${plural(n, "track")}${a.shuffle ? " shuffled" : ", starting with " + label(first)}.`;
    return { ok: true, text: [base, ...notes].join(" ") };
  }

  private playLocal(a: PlayArgs, words: string): Result {
    const limit = Math.min(MAX_SEND, Math.max(1, Math.floor(a.limit ?? MAX_SEND)));
    if (this.d.library.stats().tracks === 0) return { ok: false, text: this.emptyReason() };
    const found = this.d.library.list({ q: words, limit });
    if (found.total === 0) return { ok: false, text: `No music matches "${words}".` };
    const mode = a.mode ?? "replace";
    const failed = this.send({ action: "play", tracks: found.tracks.map(ref), mode, ...(a.shuffle ? { shuffle: true } : {}) });
    if (failed) return failed;
    const first = found.tracks[0]!;
    const n = found.tracks.length;
    if (mode === "add") return { ok: true, text: `Added ${plural(n, "track")} to the queue.` };
    if (mode === "next") return { ok: true, text: `Queued ${plural(n, "track")} to play next, starting with ${label(first)}.` };
    return { ok: true, text: `Playing ${plural(n, "track")}${a.shuffle ? " shuffled" : ", starting with " + label(first)}.` };
  }

  control(a: ControlArgs): Result {
    const bad = (text: string): Result => ({ ok: false, text });
    const simple = ["pause", "resume", "toggle", "stop", "next", "previous"];
    let command: MusicCommand;
    if (simple.includes(a.action)) command = { action: a.action as MusicCommand["action"] };
    else if (a.action === "volume") {
      if (typeof a.level === "number") command = { action: "volume", level: Math.min(100, Math.max(0, Math.round(a.level))) };
      else if (typeof a.delta === "number") command = { action: "volume", delta: Math.min(100, Math.max(-100, Math.round(a.delta))) };
      else return bad("Say what volume: a level from 0 to 100, or a step up or down.");
    } else if (a.action === "seek") {
      if (typeof a.seconds === "number") command = { action: "seek", seconds: Math.max(0, a.seconds) };
      else if (typeof a.percent === "number") command = { action: "seek", percent: Math.min(100, Math.max(0, a.percent)) };
      else return bad("Say where to seek: a number of seconds, or a percent of the track.");
    } else if (a.action === "mute" || a.action === "shuffle") command = { action: a.action, ...(typeof a.on === "boolean" ? { on: a.on } : {}) };
    else if (a.action === "repeat") {
      if (a.mode !== "off" && a.mode !== "all" && a.mode !== "one") return bad("Repeat is off, all or one.");
      command = { action: "repeat", mode: a.mode };
    } else if (a.action === "view") {
      if (a.view !== "mini" && a.view !== "full" && a.view !== "hidden") return bad("The view is mini, full or hidden.");
      command = { action: "view", view: a.view };
    } else return bad(`I do not know the music control "${a.action}".`);
    return this.send(command) ?? { ok: true, text: "Done." };
  }

  async queue(a: QueueArgs): Promise<Result> {
    if (a.action === "add") return this.play({ query: a.query, mode: "add", ...(a.source ? { source: a.source } : {}) });
    if (a.action === "remove") {
      if (!Number.isInteger(a.index) || (a.index as number) < 1) return { ok: false, text: "Say which queue number to remove (counting from 1)." };
      return this.send({ action: "queue.remove", index: (a.index as number) - 1 }) ?? { ok: true, text: `Removed number ${a.index} from the queue.` };
    }
    if (a.action === "clear") return this.send({ action: "queue.clear" }) ?? { ok: true, text: "The queue is cleared." };
    const t = this.target();
    if (!t) return { ok: false, text: NO_SCREEN };
    const q = t.state?.queue ?? [];
    if (!q.length) return { ok: true, text: "The queue is empty." };
    return { ok: true, text: `The queue has ${plural(q.length, "track")}:\n${q.map((x, i) => `${i + 1}. ${x.title}${i === t.state!.index ? " (playing)" : ""}`).join("\n")}` };
  }

  async search(a: { query: string; limit?: number; source?: "local" | "spotify" | "any" }): Promise<Result> {
    const source = a.source ?? this.defaultSource();
    if (source !== "local" && this.d.sources) {
      const found = await this.d.sources.search(a.query, { source, ...(a.limit ? { limit: Math.min(15, a.limit) } : {}) });
      const lines = found.tracks.map((t) => `- ${t.title}${t.artist ? ` — ${t.artist}` : ""}${t.album ? ` (${t.album})` : ""} [${t.source === "local" ? "folder" : "Spotify"}]`);
      if (!lines.length) return { ok: true, text: found.notes.length ? found.notes.join(" ") : `No music matches "${a.query.trim()}".` };
      return { ok: true, text: [`${plural(lines.length, "track")} found for "${a.query.trim()}":`, ...lines, ...found.notes].join("\n") };
    }
    const limit = Math.min(15, Math.max(1, Math.floor(a.limit ?? 10)));
    if (this.d.library.stats().tracks === 0) return { ok: true, text: this.emptyReason() };
    const found = this.d.library.list({ q: a.query, limit });
    if (found.total === 0) return { ok: true, text: a.query.trim() ? `No music matches "${a.query.trim()}".` : this.emptyReason() };
    const lines = found.tracks.map((t) => `- ${t.title}${t.artist ? ` — ${t.artist}` : ""}${t.album ? ` (${t.album})` : ""}`);
    return { ok: true, text: `${plural(found.total, "track")} match${found.total === 1 ? "es" : ""} "${a.query.trim()}":\n${lines.join("\n")}${found.total > lines.length ? `\n...and ${found.total - lines.length} more.` : ""}` };
  }

  nowPlaying(): Result {
    const t = this.target();
    if (!t) return { ok: false, text: NO_SCREEN };
    const s = t.state;
    if (!s || (!s.trackId && !s.title)) return { ok: true, text: "Nothing is playing." };
    const where = s.queue.length ? `, track ${s.index + 1} of ${s.queue.length}` : "";
    return {
      ok: true,
      text: `${s.playing ? "Playing" : "Paused"}: ${label(s)}${s.album ? ` (album ${s.album})` : ""}, ${clock(s.position)} of ${clock(s.duration)}${where}. Volume ${s.volume}${s.muted ? " (muted)" : ""}, shuffle ${s.shuffle ? "on" : "off"}, repeat ${s.repeat}.`,
    };
  }
}
