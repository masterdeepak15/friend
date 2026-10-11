import type { MusicCommand, MusicState, MusicTrackRef, ServerMsg } from "@friend/protocol";
import type { MusicLibrary, PublicTrack } from "./library";

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
}

/**
 * Between the assistant and the music player on the owner's screen. The player lives in the browser; this finds the screen that
 * should play (the active one, or the newest), sends it commands, and remembers what it last said about itself.
 */
export class MusicHub {
  private conns = new Map<MusicConn, { state: MusicState | null; at: number; order: number }>();
  private order = 0;

  constructor(private d: { library: MusicLibrary }) {}

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

  play(a: PlayArgs): Result {
    const words = [a.query, a.title, a.artist, a.album].filter((w): w is string => typeof w === "string" && w.trim() !== "").join(" ");
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

  queue(a: QueueArgs): Result {
    if (a.action === "add") return this.play({ query: a.query, mode: "add" });
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

  search(a: { query: string; limit?: number }): Result {
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
