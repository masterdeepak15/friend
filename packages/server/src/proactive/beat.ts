import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { conversationText } from "../agent/compact";
import { loadHistory } from "../agent/history";
import type { ProactiveConfig } from "../config";
import type { Db } from "../db";
import type { MemoryTree } from "../memory/tree";
import type { Provider } from "../provider/types";
import type { Tasks } from "../tasks";

/** What woke Friend, and the plain facts about it. Everything here is worked out in code: no model is asked until something is found. */
export interface Signal {
  key: string;
  kind: "overdue" | "morning" | "evening" | "dated" | "silence";
  /** Facts for the model, one per line. */
  facts: string[];
  /** The level that includes it. */
  level: 1 | 2 | 3;
}

interface State {
  day: string;
  sent: number;
  lastAt: number;
  /** When each signal was last dealt with (spoken about, or judged not worth a word). */
  fired: Record<string, number>;
  /** What was said today, so it is not said again. */
  said: string[];
}

export interface BeatDeps {
  config: () => ProactiveConfig;
  provider: Provider;
  db: Db;
  tree: MemoryTree | null;
  tasks: Tasks;
  /** One line about the Office (who is working, what is waiting), or null. */
  officeLine?: () => string | null;
  /** How many of the owner's screens are open. */
  screens: () => number;
  busy: () => boolean;
  assistantName: () => string;
  /** Whether a phone channel is ready to take a message to the owner. */
  phoneReady?: () => boolean;
  /** Puts the words in front of the owner. */
  deliver: (text: string, how: { speak: boolean; screens: number; phone: boolean }) => Promise<void> | void;
  audit: { log: (actor: "agent" | "system", action: string, detail: Record<string, unknown>) => void };
  now?: () => number;
  /** Where the day's counts are kept, so a restart does not forget what was already said. */
  statePath: string;
}

export type BeatResult = { spoke: true; kind: Signal["kind"]; text: string } | { spoke: false; why: string; kind?: Signal["kind"] };

const LEVEL: Record<ProactiveConfig["level"], number> = { off: 0, low: 1, medium: 2, high: 3 };
/** Longest a proactive message may be. */
const MAX_SAY = 400;
const OVERDUE_AFTER_MS = 2 * 3_600_000;
/** The owner spoke this recently: Friend does not cut in. */
const ACTIVE_MS = 3 * 60_000;
const RECENT_LINES = 6;

const SYSTEM = (name: string) => `You are ${name}, the owner's personal assistant, deciding whether to speak first. You are told why you woke up, a few facts, what you know about the owner, and what was said recently. Speak only if it is useful and kind: one or two short, warm, natural sentences in the way the owner likes to be spoken to (their notes tell you the language and tone). Never repeat anything already said today, never nag, never invent anything: use only the facts given. If there is nothing worth saying, say nothing.
Reply with JSON only: {"say":"the words"} or {"say":null}.`;

const hm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const minutesOf = (d: Date): number => d.getHours() * 60 + d.getMinutes();
const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whether a time of day falls between two clock times, which may wrap past midnight. */
export function within(minute: number, from: string, to: string): boolean {
  const a = hm(from);
  const b = hm(to);
  return a === b ? false : a < b ? minute >= a && minute < b : minute >= a || minute < b;
}

const ago = (ms: number): string => {
  const h = Math.round(ms / 3_600_000);
  return h >= 24 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} hours` : `${Math.max(1, Math.round(ms / 60_000))} minutes`;
};

/**
 * The part of Friend that can start a conversation. A quiet check runs every minute and costs nothing: it looks for something worth
 * a word (a task long overdue, the morning, the evening, something in memory dated today, a long silence). Only when it finds one,
 * and the owner's limits allow (level, quiet hours, a daily cap, a gap between contacts, not while they are talking), is the model asked,
 * once, whether to say anything and what. The model has no tools: it can only choose words, and the words go through `deliver`.
 */
export class ProactiveBeat {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private d: BeatDeps) {}

  start(everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e: Error) => this.d.audit.log("system", "proactive.failed", { message: e.message })), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private load(day: string): State {
    try {
      if (existsSync(this.d.statePath)) {
        const s = JSON.parse(readFileSync(this.d.statePath, "utf8")) as Partial<State>;
        if (s.day === day) return { day, sent: s.sent ?? 0, lastAt: s.lastAt ?? 0, fired: s.fired ?? {}, said: s.said ?? [] };
        // a new day: the counts start again, but what fired is kept for a week so a one-time signal is not repeated
        const week = this.now() - 7 * 86_400_000;
        return { day, sent: 0, lastAt: s.lastAt ?? 0, fired: Object.fromEntries(Object.entries(s.fired ?? {}).filter(([, t]) => t > week)), said: [] };
      }
    } catch {
      /* a broken file starts the day fresh */
    }
    return { day, sent: 0, lastAt: 0, fired: {}, said: [] };
  }

  private save(s: State): void {
    try {
      writeFileSync(this.d.statePath, JSON.stringify(s));
    } catch {
      /* the counts are kept in memory for this run */
    }
  }

  /** When the owner last said something, or null. */
  private lastOwnerAt(): number | null {
    const r = this.d.db.prepare("select max(created_at) t from messages where role = 'user'").get() as { t: number | null };
    return r.t;
  }

  /** What is worth a word right now, most important first. Nothing is read from the internet or sent anywhere. */
  signals(s: State): Signal[] {
    const c = this.d.config();
    const lvl = LEVEL[c.level];
    const at = new Date(this.now());
    const minute = minutesOf(at);
    const day = s.day;
    const out: Signal[] = [];

    if (lvl >= 1) {
      for (const t of this.d.tasks.list()) {
        if (t.dueAt !== null && this.now() - t.dueAt >= OVERDUE_AFTER_MS && !t.repeat) {
          out.push({ key: `overdue:${t.id}`, kind: "overdue", level: 1, facts: [`The task "${t.title}" was due ${ago(this.now() - t.dueAt)} ago and is still on the list.`] });
        }
      }
    }
    const here = this.d.screens() > 0 || (c.phone && !!this.d.phoneReady?.());
    if (lvl >= 2 && here) {
      const open = this.d.tasks.list();
      const todays = open.filter((t) => t.dueAt !== null && dayKey(new Date(t.dueAt)) === day);
      const office = this.d.officeLine?.() ?? null;
      if (minute >= hm(c.morningAt) && minute < hm(c.morningAt) + 240) {
        out.push({
          key: `morning:${day}`,
          kind: "morning",
          level: 2,
          facts: [`It is the morning of ${at.toDateString()}.`, todays.length ? `Due today: ${todays.map((t) => t.title).join("; ")}.` : "Nothing is due today.", `${open.length} items are open on the task list.`, ...(office ? [`Office: ${office}`] : [])],
        });
      }
      if (minute >= hm(c.eveningAt) && !within(minute, c.quietFrom, c.quietTo)) {
        out.push({ key: `evening:${day}`, kind: "evening", level: 2, facts: [`It is the evening of ${at.toDateString()}.`, todays.length ? `Due today: ${todays.map((t) => t.title).join("; ")}.` : "Nothing was due today.", ...(office ? [`Office: ${office}`] : []), "Ask, lightly, how the day went."] });
      }
    }
    if (lvl >= 2 && this.d.tree) {
      const today = day;
      const tomorrow = dayKey(new Date(this.now() + 86_400_000));
      for (const n of this.d.tree.notes()) {
        for (const date of new Set(`${n.title} ${n.summary} ${n.body}`.match(/\b20\d\d-\d\d-\d\d\b/g) ?? [])) {
          if (date !== today && date !== tomorrow) continue;
          out.push({ key: `dated:${n.path}:${date}`, kind: "dated", level: 2, facts: [`A note in memory (${n.path}) mentions ${date === today ? "today" : "tomorrow"}: ${n.title}. ${n.body.replace(/\s+/g, " ").slice(0, 200)}`] });
        }
      }
    }
    if (lvl >= 3 && here) {
      const last = this.lastOwnerAt();
      if (last !== null && this.now() - last >= c.silenceHours * 3_600_000 && minute >= hm(c.morningAt) && !within(minute, c.quietFrom, c.quietTo)) {
        out.push({ key: `silence:${day}`, kind: "silence", level: 3, facts: [`The owner has not said anything for ${ago(this.now() - last)}.`, "Check in gently, as a friend would, without asking for anything."] });
      }
    }
    return out.filter((x) => !(x.key in s.fired));
  }

  /** One look. Returns what happened, or null when it was not the time to even look. */
  async tick(): Promise<BeatResult | null> {
    const c = this.d.config();
    if (c.level === "off" || this.stopped || this.running) return null;
    const at = new Date(this.now());
    if (within(minutesOf(at), c.quietFrom, c.quietTo)) return null;
    if (this.d.busy()) return null;
    const s = this.load(dayKey(at));
    if (s.sent >= c.dailyCap) return null;
    if (this.now() - s.lastAt < c.minGapMin * 60_000) return null;
    const last = this.lastOwnerAt();
    if (last !== null && this.now() - last < ACTIVE_MS) return null; // the owner is talking: do not cut in
    const found = this.signals(s)[0];
    if (!found) return null;
    this.running = true;
    try {
      const say = await this.decide(found, s);
      s.fired[found.key] = this.now();
      if (!say) {
        this.save(s);
        this.d.audit.log("agent", "proactive.quiet", { kind: found.kind });
        return { spoke: false, why: "nothing worth saying", kind: found.kind };
      }
      const screens = this.d.screens();
      const phone = screens === 0 && c.phone && !!this.d.phoneReady?.();
      if (screens === 0 && !phone) {
        // nobody to tell: the signal is left for when someone is there
        delete s.fired[found.key];
        this.save(s);
        return { spoke: false, why: "no screen open and no phone channel", kind: found.kind };
      }
      await this.d.deliver(say, { speak: c.speak && screens > 0, screens, phone });
      s.sent++;
      s.lastAt = this.now();
      s.said.push(say);
      this.save(s);
      this.d.audit.log("agent", "proactive.spoke", { kind: found.kind, via: screens > 0 ? "screen" : "phone", length: say.length });
      return { spoke: true, kind: found.kind, text: say };
    } finally {
      this.running = false;
    }
  }

  /** Asks the model, in a conversation of its own with no tools, whether to speak and what to say. */
  private async decide(sig: Signal, s: State): Promise<string | null> {
    const d = this.d;
    const tree = d.tree;
    const knows = tree
      ? [tree.rootIndex().slice(0, 1200), ...["language", "prefer", "tone", "style"].flatMap((w) => tree.search(w, 2)).slice(0, 4).map((f) => ({ ...f, text: tree.read(f.path) })).flatMap((f) => (f.text.ok ? [`--- ${f.path}\n${f.text.text.replace(/^---[\s\S]*?\n---\n?/, "").trim().slice(0, 400)}`] : []))].join("\n")
      : "";
    const recent = conversationText(loadHistory(d.db).slice(-RECENT_LINES));
    const ask = [
      `It is ${new Date(this.now()).toString().slice(0, 21)}.`,
      `You woke up because: ${sig.kind}.`,
      `Facts:\n${sig.facts.join("\n")}`,
      s.said.length ? `Already said today (do not repeat):\n${s.said.join("\n")}` : "Nothing said yet today.",
      knows ? `What you know about the owner:\n${knows}` : "",
      recent ? `What was said recently:\n${recent}` : "",
      "Reply with the JSON now.",
    ]
      .filter(Boolean)
      .join("\n\n");
    let out = "";
    try {
      for await (const ev of d.provider.stream({ system: SYSTEM(d.assistantName()), session: "guest", messages: [{ role: "user", content: [{ type: "text", text: ask }] }], tools: [], signal: new AbortController().signal })) {
        if (ev.type === "text_delta") out += ev.text;
        else if (ev.type === "error") return null;
      }
    } catch {
      return null;
    }
    const a = out.indexOf("{");
    const b = out.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try {
      const say = (JSON.parse(out.slice(a, b + 1)) as { say?: unknown }).say;
      if (typeof say !== "string") return null;
      const clean = say.replace(/\s+/g, " ").trim();
      return clean ? clean.slice(0, MAX_SAY) : null;
    } catch {
      return null;
    }
  }
}
