import type { AudioHearing } from "./hearing";
import type { Speech } from "./speech";
import { CaptionTracker, Cooldown, concernsOwner, isAddressed, isOwnerSpeaking, type CaptionItem, type Line } from "./logic";
import type { MeetingPrefs, MeetingStatus } from "./store";

export interface ChatMessage {
  sender: string;
  text: string;
}

/** What to show to the meeting: slides it writes itself, or a picture or film (base64) from a file. */
export type Presentation =
  | { kind: "slides"; slides: Slide[]; start?: number }
  | { kind: "image"; mime: string; data: Buffer }
  | { kind: "video"; mime: string; data: Buffer };

/** A line of a slide: plain text, or text with what is said while it comes in (then the lines of that slide appear one by one). */
export type SlideLine = string | { text: string; say?: string };

export interface Slide {
  title: string;
  lines?: SlideLine[];
  /** What is said aloud when the slide comes up (before its lines). */
  say?: string;
}

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
  /** What is written in the meeting chat now, or null when it could not be read. */
  readChat?(): Promise<ChatMessage[] | null>;
  /** Who is in the meeting and who is speaking this moment (names as the meeting shows them), or null when it cannot tell. */
  people?(): Promise<{ names: string[]; speaking: string[] } | null>;
  /** Shares the screen of the meeting with this content. */
  present?(c: Presentation): Promise<{ ok: boolean; message: string }>;
  /** Moves slides on (1) or back (-1); false when nothing is being shown. */
  flip?(by: number): Promise<boolean>;
  stopPresenting?(): Promise<boolean>;
  /** Makes the first n lines of the slide on the stage appear (with their animation). */
  reveal?(n: number): Promise<boolean>;
  /** A picture of the meeting screen as it is now (what someone is sharing), or null. */
  look?(): Promise<{ mime: string; data: string } | null>;
}

export interface SessionEvents {
  status(status: MeetingStatus, detail: string): void;
  lines(lines: Line[]): void;
  /** The assistant was called by name: the line, and what was said just before it. */
  addressed(line: Line, context: Line[], followUp?: boolean): void;
  /** Something that concerns the owner was said. */
  ownerRelevant(line: Line, context: Line[]): void;
  /** Time to bring the notes up to date. */
  notesDue(): void;
  /** Something the owner should know about how the meeting is going (captions off, chat unavailable). */
  problem(text: string): void;
  ended(reason: string): void;
  /** How long a step took (milliseconds), so a slow answer can be traced to its step. */
  timing?(step: string, ms: number): void;
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
  private pending: { line: Line; due: number; limit: number; follow?: boolean } | null = null;
  /** For a little while after it was called or answered, the next thing said is most likely meant for it too, whether or not it says its name again. */
  private conversationUntil = 0;
  private linesSinceNotes = 0;
  private lastNotes: number;
  private done: Promise<void> | null = null;
  private status: MeetingStatus | null = null;
  private audioMode = false;
  private lastHeard = 0;
  private lastSpoke = 0;
  /** Sound that arrives while it speaks (and just after) is its own voice coming back through someone's speakers: not listened to. */
  private deafUntil = 0;

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
  async speak(text: string, o: { narration?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
    const d = this.d;
    if (!o.narration) this.narrateToken++; // someone is being answered: the talk through the slides stops here
    if (this.status !== "live") return { ok: false, message: "It is not in the meeting." };
    if (!d.speech || !d.page.speak || !d.page.mic) return { ok: false, message: "Speaking aloud is not switched on here." };
    if (!o.narration && this.now() - this.lastSpoke < 6_000) return { ok: false, message: "It spoke a moment ago: wait a few seconds between spoken answers." };
    this.lastSpoke = this.now();
    const t0 = Date.now();
    // a person does not talk over someone
    // (in audio mode what counts is the sound itself, not the line made from it a few seconds later)
    const quietFor = () => (d.hearing && this.audioMode ? Date.now() - d.hearing.lastVoiceAt : this.now() - this.lastHeard);
    // (the voice is made while it waits for the room to go quiet, not after)
    const making = d.speech(text.slice(0, 400)).catch(() => null);
    for (let w = 0; quietFor() < (this.audioMode ? 500 : 1500) && w < 40; w++) await this.sleep(150);
    const wav = await making;
    d.events.timing?.("speak.prepare", Date.now() - t0);
    if (!wav) return { ok: false, message: "This PC has no voice to speak with." };
    if (!(await d.page.mic(true).catch(() => false))) return { ok: false, message: "It could not switch the microphone on in the meeting." };
    let ok = false;
    this.deafUntil = Number.MAX_SAFE_INTEGER;
    try {
      ok = await d.page.speak(wav).catch(() => false);
    } finally {
      this.deafUntil = this.now() + 3000;
      this.conversationUntil = this.now() + 45_000; // the answer may be followed by a question
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
          await this.watchPeople().catch(() => {});
          await this.watchChat().catch(() => {});
        } else if (this.now() - began > 120_000 && !inSince) {
          reason = s.detail || "It could not join the meeting.";
          d.events.problem(reason);
          this.set("failed", reason);
          return void (await d.page.close());
        }
        await this.sleep(this.audioMode ? Math.min(poll, 300) : poll);
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
    if (pcm && this.now() >= this.deafUntil) d.hearing?.push(pcm);
    const lines = (d.hearing?.take() ?? []).map((l) => (l.verified ? l : { ...l, speaker: this.who(l.speaker) }));
    if (lines.length) this.take(lines);
  }

  /** People in the meeting, as the page last showed them, and who was seen speaking just now. */
  private roster: string[] = [];
  private seenSpeaking: { name: string; at: number }[] = [];
  private lastPeople = 0;
  private lastChatRead = 0;
  private chatSeen = new Set<string>();
  private chatReady = false;

  private isSelf(name: string): boolean {
    const n = name.trim().toLowerCase();
    return !n || n === this.d.selfName.trim().toLowerCase() || n === "you" || n.startsWith(`${this.d.selfName.trim().toLowerCase()} (`);
  }

  private async watchPeople(): Promise<void> {
    if (!this.d.page.people || this.now() - this.lastPeople < 1200) return;
    this.lastPeople = this.now();
    const p = await this.d.page.people();
    if (!p) return;
    this.roster = p.names.filter((n) => !this.isSelf(n));
    for (const n of p.speaking) if (!this.isSelf(n)) this.seenSpeaking.push({ name: n, at: this.now() });
    this.seenSpeaking = this.seenSpeaking.filter((s) => this.now() - s.at < 12_000);
  }

  /** A line from "Someone" gets the name the meeting shows: whoever was seen speaking just now, or the one other person who is there. */
  private who(speaker: string): string {
    if (speaker.trim().toLowerCase() !== "someone") return speaker;
    const recent = [...new Set(this.seenSpeaking.filter((s) => this.now() - s.at < 8000).map((s) => s.name))];
    if (recent.length === 1) return recent[0]!;
    const owners = this.d.prefs().ownerNames.map((n) => n.toLowerCase());
    const others = this.roster.filter((n) => !owners.some((o) => n.toLowerCase().includes(o)));
    return others.length === 1 ? others[0]! : speaker;
  }

  /** What people write in the chat is read like what they say: it is kept, and it can be addressed to the assistant. */
  private async watchChat(): Promise<void> {
    if (!this.d.page.readChat || this.now() - this.lastChatRead < 3000) return;
    this.lastChatRead = this.now();
    const msgs = await this.d.page.readChat();
    if (!msgs) return;
    const fresh: Line[] = [];
    const counts = new Map<string, number>();
    for (const m of msgs) {
      const base = `${m.sender}\u0000${m.text}`;
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      const key = `${base}\u0000${n}`;
      if (this.chatSeen.has(key)) continue;
      this.chatSeen.add(key);
      if (this.chatReady && !this.isSelf(m.sender) && m.text.trim()) fresh.push({ speaker: m.sender, text: `(in the chat) ${m.text.trim()}` });
    }
    this.chatReady = true; // what was written before it came in is history, not read as new
    if (fresh.length) this.take(fresh);
  }

  /** Shows something to the meeting by sharing its screen. */
  async present(c: Presentation): Promise<{ ok: boolean; message: string }> {
    if (this.status !== "live") return { ok: false, message: "It is not in the meeting." };
    if (!this.d.page.present) return { ok: false, message: "This meeting page cannot share a screen." };
    this.narrateToken++;
    const r = await this.d.page.present(c);
    if (!r.ok || c.kind !== "slides" || !c.slides.some((s) => s.say || s.lines?.some((l) => typeof l !== "string" && l.say))) return r;
    if (!this.d.speech || !this.d.page.speak) return { ok: true, message: `${r.message} Speaking aloud is not switched on, so the slides are shown without talking.` };
    void this.narrate(c.slides);
    return { ok: true, message: `${r.message} It is talking through the ${c.slides.length} slides, turning to the next when each is told. Anyone who speaks to it stops the talk.` };
  }

  private narrateToken = 0;

  /**
   * Talks through the slides: the introduction of each slide, then each of its lines that comes in with its animation while that line is
   * explained, and on to the next slide when everything of this one is said, so what is shown and what is heard stay together.
   */
  private async narrate(slides: Slide[]): Promise<void> {
    const token = ++this.narrateToken;
    const going = () => token === this.narrateToken && this.status === "live";
    for (let i = 0; i < slides.length && going(); i++) {
      const s = slides[i]!;
      if (s.say && !(await this.speak(s.say, { narration: true })).ok) return;
      const lines = s.lines ?? [];
      const animated = lines.some((l) => typeof l !== "string" && l.say);
      if (animated) {
        for (let j = 0; j < lines.length && going(); j++) {
          await this.d.page.reveal?.(j + 1).catch(() => false);
          await this.sleep(450); // the line comes in
          const l = lines[j]!;
          const say = typeof l === "string" ? undefined : l.say;
          if (say) {
            if (!(await this.speak(say, { narration: true })).ok) return;
          } else await this.sleep(2500);
        }
      } else if (!s.say) await this.sleep(4000);
      if (!going()) return;
      await this.sleep(500);
      if (i < slides.length - 1) await this.d.page.flip?.(1).catch(() => false);
    }
  }

  /** What the meeting screen shows now (the screen someone shares), as a picture. */
  async look(): Promise<{ mime: string; data: string } | null> {
    if (this.status !== "live") return null;
    return (await this.d.page.look?.().catch(() => null)) ?? null;
  }

  /** The chat as it is on the screen now. */
  async chatNow(): Promise<ChatMessage[] | null> {
    return (await this.d.page.readChat?.().catch(() => null)) ?? null;
  }

  /** The names the meeting shows, and who is speaking this moment. */
  async peopleNow(): Promise<{ names: string[]; speaking: string[] } | null> {
    return (await this.d.page.people?.().catch(() => null)) ?? null;
  }

  async flip(by: number): Promise<boolean> {
    return (await this.d.page.flip?.(by).catch(() => false)) === true;
  }

  async stopPresenting(): Promise<boolean> {
    this.narrateToken++;
    return (await this.d.page.stopPresenting?.().catch(() => false)) === true;
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
      const byName = isAddressed(l, d.names(), d.selfName, this.audioMode);
      const follow = !byName && this.now() < this.conversationUntil && l.speaker.trim().toLowerCase() !== d.selfName.trim().toLowerCase() && l.text.trim().split(/\s+/).length >= 3;
      if (byName || follow) {
        if (byName) this.conversationUntil = this.now() + 45_000;
        // wait for the speaker to finish: a later line from the same person pushes the answer back a little
        const due = this.now() + this.replyDelay();
        this.pending = this.pending && this.pending.line.speaker === l.speaker ? { line: l, due: Math.min(due, this.pending.limit), limit: this.pending.limit, ...(follow && this.pending.follow ? { follow } : {}) } : { line: l, due, limit: this.now() + 8000, ...(follow ? { follow } : {}) };
      } else if (this.pending && this.pending.line.speaker === l.speaker) {
        this.pending = { ...this.pending, due: Math.min(this.now() + this.replyDelay(), this.pending.limit) };
      } else if (concernsOwner(l, prefs.ownerNames, prefs.keywords) && this.cool.take("owner", this.now())) {
        d.events.ownerRelevant(l, this.transcript());
      }
    }
  }

  /** How long it waits after someone stops before it answers: captions arrive a while after the speech, sound is cut at the pause already. */
  private replyDelay(): number {
    return this.d.replyDelayMs ?? (this.audioMode ? 300 : 1500);
  }

  private tick(): void {
    const p = this.pending;
    if (p && this.now() >= p.due) {
      this.pending = null;
      this.d.events.addressed(p.line, this.transcript(), p.follow);
    }
    const every = this.d.prefs().notesEveryMinutes * 60_000;
    if (this.linesSinceNotes >= 4 && this.now() - this.lastNotes >= every) {
      this.lastNotes = this.now();
      this.linesSinceNotes = 0;
      this.d.events.notesDue();
    }
  }
}
