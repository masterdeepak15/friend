import type { Db } from "../db";

export type MeetingStatus = "scheduled" | "joining" | "lobby" | "live" | "ended" | "failed" | "cancelled";

export interface MeetingTask {
  what: string;
  who?: string;
  due?: string;
}

export interface Meeting {
  id: number;
  url: string;
  title: string;
  joinName: string;
  status: MeetingStatus;
  detail: string;
  startsAt: number;
  startedAt: number;
  endedAt: number;
  summary: string;
  decisions: string[];
  tasks: MeetingTask[];
  createdAt: number;
}

export interface MeetingPrefs {
  names: string[];
  ownerNames: string[];
  keywords: string[];
  joinName: string;
  notesEveryMinutes: number;
  /** Answer aloud when called by name (in a computer voice); on unless the owner turns it off. If speaking fails it writes in the chat. */
  speak: boolean;
}

export const DEFAULT_PREFS: MeetingPrefs = { names: [], ownerNames: [], keywords: [], joinName: "", notesEveryMinutes: 5, speak: true };

interface Row {
  id: number;
  url: string;
  title: string;
  join_name: string;
  status: string;
  detail: string;
  starts_at: number;
  started_at: number;
  ended_at: number;
  summary: string;
  decisions: string;
  tasks: string;
  created_at: number;
}

const parse = <T>(s: string, fallback: T): T => {
  try {
    const v = JSON.parse(s) as T;
    return v ?? fallback;
  } catch {
    return fallback;
  }
};

const toMeeting = (r: Row): Meeting => ({
  id: r.id,
  url: r.url,
  title: r.title,
  joinName: r.join_name,
  status: r.status as MeetingStatus,
  detail: r.detail,
  startsAt: r.starts_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summary: r.summary,
  decisions: parse<string[]>(r.decisions, []),
  tasks: parse<MeetingTask[]>(r.tasks, []),
  createdAt: r.created_at,
});

/** Meetings, what was said in them and the owner's settings for them. The words are kept on this PC only, and go with the meeting when it is removed. */
export class MeetingStore {
  constructor(private db: Db) {}

  create(m: { url: string; title: string; joinName: string; startsAt: number }, now = Date.now()): Meeting {
    const r = this.db.prepare("insert into meetings (url, title, join_name, status, starts_at, created_at) values (?, ?, ?, 'scheduled', ?, ?)").run(m.url, m.title, m.joinName, m.startsAt, now);
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Meeting | null {
    const r = this.db.prepare("select * from meetings where id = ?").get(id) as Row | undefined;
    return r ? toMeeting(r) : null;
  }

  list(limit = 20): Meeting[] {
    return (this.db.prepare("select * from meetings order by case when status in ('live','lobby','joining') then 0 when status = 'scheduled' then 1 else 2 end, coalesce(nullif(started_at, 0), starts_at) desc, id desc limit ?").all(limit) as Row[]).map(toMeeting);
  }

  /** The meeting being attended now, else the latest one. */
  current(): Meeting | null {
    const live = this.db.prepare("select * from meetings where status in ('live','lobby','joining') order by id desc limit 1").get() as Row | undefined;
    if (live) return toMeeting(live);
    const last = this.db.prepare("select * from meetings where status not in ('scheduled','cancelled') order by id desc limit 1").get() as Row | undefined;
    return last ? toMeeting(last) : null;
  }

  /** Scheduled meetings whose time has come (a minute early). */
  due(now: number, early = 60_000): Meeting[] {
    return (this.db.prepare("select * from meetings where status = 'scheduled' and starts_at <= ? order by starts_at").all(now + early) as Row[]).map(toMeeting);
  }

  setStatus(id: number, status: MeetingStatus, detail = "", now = Date.now()): void {
    const extra = status === "live" ? ", started_at = case when started_at = 0 then ? else started_at end" : status === "ended" || status === "failed" || status === "cancelled" ? ", ended_at = ?" : "";
    const args: unknown[] = [status, detail];
    if (extra) args.push(now);
    args.push(id);
    this.db.prepare(`update meetings set status = ?, detail = ?${extra} where id = ?`).run(...args);
  }

  saveNotes(id: number, n: { summary: string; decisions: string[]; tasks: MeetingTask[] }): void {
    this.db.prepare("update meetings set summary = ?, decisions = ?, tasks = ? where id = ?").run(n.summary, JSON.stringify(n.decisions), JSON.stringify(n.tasks), id);
  }

  addLines(id: number, lines: { speaker: string; text: string }[], now = Date.now()): void {
    const ins = this.db.prepare("insert into meeting_lines (meeting_id, at, speaker, text) values (?, ?, ?, ?)");
    for (const l of lines) ins.run(id, now, l.speaker.slice(0, 120), l.text.slice(0, 4000));
  }

  lines(id: number, opts: { last?: number; after?: number } = {}): { id: number; at: number; speaker: string; text: string }[] {
    if (opts.after !== undefined) return this.db.prepare("select id, at, speaker, text from meeting_lines where meeting_id = ? and id > ? order by id").all(id, opts.after) as never;
    const rows = this.db.prepare("select id, at, speaker, text from meeting_lines where meeting_id = ? order by id desc limit ?").all(id, opts.last ?? 30) as { id: number; at: number; speaker: string; text: string }[];
    return rows.reverse();
  }

  lineCount(id: number): number {
    return (this.db.prepare("select count(*) as n from meeting_lines where meeting_id = ?").get(id) as { n: number }).n;
  }

  remove(id: number): void {
    this.db.prepare("delete from meetings where id = ?").run(id);
  }

  /** A Friend that was stopped in the middle of a meeting must not think it is still in it. */
  abandonLive(now = Date.now()): void {
    this.db.prepare("update meetings set status = 'ended', detail = 'Friend was stopped during the meeting.', ended_at = ? where status in ('live','lobby','joining')").run(now);
  }

  prefs(): MeetingPrefs {
    const rows = this.db.prepare("select key, value from meeting_prefs").all() as { key: string; value: string }[];
    const out: MeetingPrefs = { ...DEFAULT_PREFS };
    for (const r of rows) {
      const v = parse<unknown>(r.value, null);
      if (r.key === "joinName" && typeof v === "string") out.joinName = v;
      else if (r.key === "speak" && typeof v === "boolean") out.speak = v;
      else if (r.key === "notesEveryMinutes" && typeof v === "number") out.notesEveryMinutes = Math.max(2, Math.min(30, Math.round(v)));
      else if ((r.key === "names" || r.key === "ownerNames" || r.key === "keywords") && Array.isArray(v)) out[r.key] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  }

  setPrefs(p: Partial<MeetingPrefs>): MeetingPrefs {
    const put = this.db.prepare("insert into meeting_prefs (key, value) values (?, ?) on conflict (key) do update set value = excluded.value");
    for (const [k, v] of Object.entries(p)) if (v !== undefined) put.run(k, JSON.stringify(v));
    return this.prefs();
  }
}
