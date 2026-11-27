import type { AudioHearing } from "./hearing";
import type { Speech } from "./speech";
import { CaptionTracker, Cooldown, concernsOwner, isAddressed, isOwnerSpeaking, type CaptionItem, type Line } from "./logic";
import type { MeetingPrefs, MeetingStatus } from "./store";

export type Phase = "loading" | "prejoin" | "lobby" | "in" | "ended" | "unknown";

/** One meeting page in a browser: the part of a session that touches a real screen. */
export interface MeetingPage {
  /** Opens the invitation. */
  open(url: string, name: string): Promise<void>;
  /** Does whatever the screen in front of it needs to get further in (the guest name, the join button), and says which screen it is. */
  advance(name: string): Promise<{ phase: Phase; detail: string }>;
  /** What the live caption panel shows now, or null when captions are not on. */
  captions(): Promise<CaptionItem[] | null>;
  enableCaptions(): Promise<void>;
  /** Writes in the meeting chat. False when it could not. */
  chat(text: string): Promise<boolean>;
  leave(): Promise<void>;
  close(): Promise<void>;
  /** Switches the meeting camera (the picture of the assistant) on or off. */
  camera?(on: boolean): Promise<boolean>;
  /** Switches the meeting microphone on or off; false when its button was not found. Pages that cannot speak leave this out. */
  mic?(on: boolean): Promise<boolean>;
  /** Plays a spoken WAV into the meeting microphone; true when it was played to the end. */
  speak?(wav: Buffer): Promise<boolean>;
  /** The sound of the other people since the last call (16 kHz, 16-bit, mono), or null when there is none to give. */
  audio?(): Promise<Buffer | null>;
}

export interface SessionEvents {
  status(status: MeetingStatus, detail: string): void;
  lines(lines: Line[]): void;
  /** The assistant was called by name: the line, and what was said just before it. */
  addressed(line: Line, context: Line[]): void;
  /** Something that concerns the owner was said. */
  ownerRelevant(line: Line, context: Line[]): void;
  /** Time to bring the notes up to date. */
  notesDue(): void;
  /** Something the owner should know about how the meeting is going (captions off, chat unavailable). */
  problem(text: string): void;
  ended(reason: string): void;
}

export interface SessionDeps {
  page: MeetingPage;
  url: string;
  /** The name it joins with, and the name it is called in the captions. */
  selfName: string;
  /** The name people call it: its own and the owner's extra names. */
  names: () => string[];
  prefs: () => MeetingPrefs;
  /** Written in the chat when it arrives, so nobody is recorded without knowing. */
  announcement: string;
  events: SessionEvents;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long to wait to be let in from the lobby. */
  admitTimeoutMs?: number;
  settleMs?: number;
  /** How long after being called it waits for the speaker to finish. */
  replyDelayMs?: number;
  /** Turns the sound of the call into lines when it has no live captions (a speech model on this PC). */
  hearing?: AudioHearing;
  /** A voice, when the owner switched speaking aloud on. */
  speech?: Speech;
}

const CONTEXT = 14;

/** Listens to one meeting. Plain code watches every line; the model is only asked when the assistant is called, when the owner is concerned, and now and then for notes. */
export class MeetingSession {
  private stopped: string | null = null;
  private tracker: CaptionTracker;
  private recent: Line[] = [];
  private ownerSpokeAt = 0;
  private lastChat = 0;
  private cool = new Cooldown(60_000);
  private pending: { line: Line; due: number; limit: number } | null = null;
  private linesSinceNotes = 0;
  private lastNotes: number;
  private done: Promise<void> | null = null;
  private status: MeetingStatus | null = null;
  private audioMode = false;
  private lastHeard = 0;
  private lastSpoke = 0;

  constructor(private d: SessionDeps) {
    this.tracker = new CaptionTracker(d.settleMs ?? 2500);
    this.lastNotes = this.now();
  }

  private now = () => (this.d.now ?? Date.now)();
  private sleep = (ms: number) => (this.d.sleep ?? ((n) => new Promise<void>((r) => setTimeout(r, n))))(ms);

  start(): Promise<void> {
    this.done ??= this.run().catch((e) => this.d.events.problem(`The meeting stopped: ${e instanceof Error ? e.message : "an error"}.`));
    return this.done;
  }

  /** Leaves the meeting. */
  async stop(reason = "The owner asked it to leave."): Promise<void> {
    this.stopped ??= reason;
    await this.done?.catch(() => {});
  }

  /** Whether the owner spoke in the last ten minutes: he is there. */
  ownerPresent(): boolean {
    return this.ownerSpokeAt > 0 && this.now() - this.ownerSpokeAt < 600_000;
  }

  transcript(n = CONTEXT): Line[] {
    return this.recent.slice(-n);
  }

  /** One short message in the chat, at most one every fifteen seconds. */
  async say(text: string): Promise<boolean> {
    if (this.status !== "live") return false;
    if (this.now() - this.lastChat < 15_000) return false;
    this.lastChat = this.now();
    return this.d.page.chat(text.slice(0, 600)).catch(() => false);
  }

  /** Says it aloud in a computer voice, after the room has gone quiet; at most once every 20 seconds. */
  async speak(text: string): Promise<{ ok: boolean; message: string }> {
    const d = this.d;
    if (this.status !== "live") return { ok: false, message: "It is not in the meeting." };
    if (!d.speech || !d.page.speak || !d.page.mic) return { ok: false, message: "Speaking aloud is not switched on here." };
    if (this.now() - this.lastSpoke < 20_000) return { ok: false, message: "It spoke a moment ago: wait twenty seconds between spoken answers." };
    this.lastSpoke = this.now();
    // a person does not talk over someone
    for (let w = 0; this.now() - this.lastHeard < 1500 && w < 20; w++) await this.sleep(400);
    const wav = await d.speech(text.slice(0, 400)).catch(() => null);
    if (!wav) return { ok: false, message: "This PC has no voice to speak with." };
    if (!(await d.page.mic(true).catch(() => false))) return { ok: false, message: "It could not switch the microphone on in the meeting." };
    let ok = false;
    try {
      ok = await d.page.speak(wav).catch(() => false);
    } finally {
      await d.page.mic(false).catch(() => false);
    }
    return ok ? { ok: true, message: "Said aloud." } : { ok: false, message: "It could not play the sound into the meeting." };
  }

  private set(status: MeetingStatus, detail: string): void {
    if (this.status === status) return;
    this.status = status;
    this.d.events.status(status, detail);
  }

  private async run(): Promise<void> {
    const d = this.d;
    const poll = d.pollMs ?? 1000;
    const admit = d.admitTimeoutMs ?? 10 * 60_000;
    let reason = "The meeting ended.";
    try {
      this.set("joining", "Opening the meeting.");
      await d.page.open(d.url, d.selfName);
      const began = this.now();
      let inSince = 0;
      let lobbySince = 0;
      let announced = false;
      let captionsTried = 0;
      let noCaptions = 0;
      let warned = false;
      while (!this.stopped) {
        const s = await d.page.advance(d.selfName);
        if (s.phase === "ended") {
          reason = "The meeting ended.";
          break;
        }
        if (s.phase === "lobby") {
          lobbySince ||= this.now();
          this.set("lobby", "Waiting for someone to let it in.");
          if (this.now() - lobbySince > admit) {
            reason = "Nobody let it in from the lobby.";
            d.events.problem(reason);
            this.set("failed", reason);
            return void (await d.page.close());
          }
        } else if (s.phase === "in") {
          inSince ||= this.now();
          this.set("live", "In the meeting, listening.");
          if (!announced) {
            announced = true;
            this.lastChat = 0;
            if (!(await d.page.chat(d.announcement).catch(() => false))) d.events.problem("It is in the meeting but could not write in the chat, so people were not told that it takes notes.");
            await d.page.mic?.(false).catch(() => false); // it arrives with the microphone off
            await d.page.camera?.(true).catch(() => false); // and with its picture on: it moves with the voice
          }
          await this.listen(captionsTried, noCaptions, warned).then((r) => ({ captionsTried, noCaptions, warned } = r));
        } else if (this.now() - began > 120_000 && !inSince) {
          reason = s.detail || "It could not join the meeting.";
          d.events.problem(reason);
          this.set("failed", reason);
          return void (await d.page.close());
        }
        await this.sleep(poll);
      }
      if (this.stopped) reason = this.stopped;
    } finally {
      if (this.audioMode && this.d.hearing) {
        await this.d.hearing.finish().catch(() => {});
        this.take(this.d.hearing.take());
      }
      const rest = this.tracker.flush();
      if (rest.length) this.take(rest);
      if (this.status && this.status !== "failed") {
        await this.d.page.leave().catch(() => {});
        await this.d.page.close().catch(() => {});
        this.set("ended", reason);
        this.d.events.ended(reason);
      }
    }
  }

  /** One look at the captions. */
  private async listen(tried: number, none: number, warned: boolean): Promise<{ captionsTried: number; noCaptions: number; warned: boolean }> {
    const d = this.d;
    const items = await d.page.captions().catch(() => null);
    if (items === null) {
      none++;
      if (none % 8 === 1) {
        tried++;
        await d.page.enableCaptions().catch(() => {});
      }
      if (d.hearing && d.page.audio && none > 10) await this.hear();
      if (none > 60 && !warned && !this.audioMode) {
        warned = true;
        d.events.problem("Live captions are not on in this meeting, so it cannot hear anything. The organiser may have turned them off.");
      }
    } else {
      none = 0;
      this.audioMode = false;
      const lines = this.tracker.feed(items, this.now());
      if (lines.length) this.take(lines);
    }
    this.tick();
    return { captionsTried: tried, noCaptions: none, warned };
  }

  /** With no captions: the sound of the call, read by a speech model on this PC. */
  private async hear(): Promise<void> {
    const d = this.d;
    if (!this.audioMode) {
      this.audioMode = true;
      await d.page.audio?.().catch(() => null); // what piled up before is old
      d.events.problem("Live captions are off in this meeting, so it is listening to the sound instead. It cannot tell who is speaking.");
    }
    const pcm = await d.page.audio?.().catch(() => null);
    if (pcm) d.hearing?.push(pcm);
    const lines = d.hearing?.take() ?? [];
    if (lines.length) this.take(lines);
  }

  private take(lines: Line[]): void {
    const d = this.d;
    this.lastHeard = this.now();
    const prefs = d.prefs();
    for (const l of lines) {
      this.recent.push(l);
      if (isOwnerSpeaking(l.speaker, prefs.ownerNames)) this.ownerSpokeAt = this.now();
    }
    if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
    this.linesSinceNotes += lines.length;
    d.events.lines(lines);
    for (const l of lines) {
      if (isAddressed(l, d.names(), d.selfName)) {
        // wait for the speaker to finish: a later line from the same person pushes the answer back a little
        const due = this.now() + (d.replyDelayMs ?? 1500);
        this.pending = this.pending && this.pending.line.speaker === l.speaker ? { line: l, due: Math.min(due, this.pending.limit), limit: this.pending.limit } : { line: l, due, limit: this.now() + 8000 };
      } else if (this.pending && this.pending.line.speaker === l.speaker) {
        this.pending = { ...this.pending, due: Math.min(this.now() + (d.replyDelayMs ?? 1500), this.pending.limit) };
      } else if (concernsOwner(l, prefs.ownerNames, prefs.keywords) && this.cool.take("owner", this.now())) {
        d.events.ownerRelevant(l, this.transcript());
      }
    }
  }

  private tick(): void {
    const p = this.pending;
    if (p && this.now() >= p.due) {
      this.pending = null;
      this.d.events.addressed(p.line, this.transcript());
    }
    const every = this.d.prefs().notesEveryMinutes * 60_000;
    if (this.linesSinceNotes >= 4 && this.now() - this.lastNotes >= every) {
      this.lastNotes = this.now();
      this.linesSinceNotes = 0;
      this.d.events.notesDue();
    }
  }
}
