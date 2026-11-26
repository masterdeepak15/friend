import type { Deck, DeckControl, DeckView, ServerMsg } from "@friend/protocol";

export interface PresenterDeps {
  /** Says a text aloud; ends when it has been said or was interrupted. */
  speak(text: string): Promise<void>;
  /** Stops what is being said, on every screen. */
  interrupt(): void;
  emit(m: ServerMsg): void;
  /** Calls fn after ms; the returned function cancels it. */
  setTimer(fn: () => void, ms: number): () => void;
  /** How long a paused presentation waits in silence after an answer before it goes on by itself. 0: never. */
  resumeSilenceSeconds(): number;
  /** Whether the assistant can speak right now; without a voice the items are only shown, for the time it takes to read them. */
  voiceOn(): boolean;
}

type State = "idle" | "playing" | "paused" | "ended";
/** Why it is paused: the owner spoke, an approval is waiting, or the owner pressed pause. */
type Why = "user" | "approval" | "control";

/** The pause between two slides, and how long the last slide stays after the end. */
const BEAT_MS = 1200;
const END_MS = 3000;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Plays a deck: shows each item and says it, slide after slide. The owner speaking pauses it where it is (the assistant answers),
 * and it goes on when the assistant says so, or by itself after a silence. It never calls the model while a slide plays.
 */
export class Presenter {
  private deck: Deck | null = null;
  /** The slide, and the item that is current (or next, between items). */
  private si = 0;
  private ii = 0;
  private shown = 0;
  private state: State = "idle";
  private why: Why | null = null;
  /** Every start, jump and pause makes a new run; the loop of an older run stops at its next step. */
  private run = 0;
  private waiting: { cancel: () => void; done: () => void } | null = null;
  private cancelSilence: (() => void) | null = null;
  private cancelEnd: (() => void) | null = null;

  constructor(private readonly deps: PresenterDeps) {}

  /** What the screens draw now, or null when nothing is presented. */
  view(): DeckView | null {
    if (!this.deck || this.state === "idle") return null;
    const slide = this.deck.slides[this.si]!;
    return { deckId: this.deck.id, title: this.deck.title, index: this.si, total: this.deck.slides.length, slide, shown: Math.min(this.shown, slide.items.length), state: this.state === "ended" ? "ended" : this.state === "paused" ? "paused" : "playing" };
  }

  start(deck: Deck, from?: { slide?: number; item?: number }): string {
    if (deck.slides.length === 0) return "That deck has no slides.";
    const si = (from?.slide ?? 1) - 1;
    const ii = (from?.item ?? 1) - 1;
    if (si < 0 || si >= deck.slides.length) return `There is no slide ${from?.slide} (the deck has ${deck.slides.length}).`;
    if (ii < 0 || ii > deck.slides[si]!.items.length - 1) return `Slide ${si + 1} has no item ${from?.item}.`;
    if (this.state !== "idle") this.stopAll();
    this.deck = deck;
    this.si = si;
    this.ii = ii;
    this.shown = ii;
    this.begin();
    return `Presenting "${deck.title}" (${deck.slides.length} slides).`;
  }

  /** The owner started to speak or type: it stops where it is. */
  userSpoke(): void {
    if (this.state === "playing") {
      this.pause("user");
      this.deps.interrupt();
    } else if (this.state === "paused") this.stopCountdown();
  }

  /** The assistant has answered: if it was the owner who paused it, the silence countdown starts. */
  answered(): void {
    if (this.state !== "paused" || this.why !== "user") return;
    const seconds = this.deps.resumeSilenceSeconds();
    if (seconds <= 0) return;
    this.stopCountdown();
    this.cancelSilence = this.deps.setTimer(() => {
      this.cancelSilence = null;
      if (this.state === "paused" && this.why === "user") this.resume();
    }, seconds * 1000);
  }

  /** An approval card came up (it comes first) or was answered. */
  approvalPending(on: boolean): void {
    if (on && this.state === "playing") {
      this.pause("approval");
      this.deps.interrupt();
    } else if (!on && this.state === "paused" && this.why === "approval") this.resume();
  }

  /** The deck was edited (a new deck) or deleted (null). Returns a sentence when that stopped the presentation. */
  deckChanged(id: string, deck: Deck | null): string | null {
    if (!this.deck || this.deck.id !== id || this.state === "idle") return null;
    if (!deck) {
      const title = this.deck.title;
      this.stopAll();
      return `The presentation "${title}" was deleted, so it stopped.`;
    }
    this.deck = deck;
    this.si = Math.min(this.si, deck.slides.length - 1);
    this.ii = Math.min(this.ii, deck.slides[this.si]!.items.length);
    this.shown = Math.min(this.shown, deck.slides[this.si]!.items.length);
    this.emitView();
    return null;
  }

  control(action: DeckControl, slide?: number): string {
    if (!this.deck || this.state === "idle") return "There is no presentation running.";
    const total = this.deck.slides.length;
    switch (action) {
      case "pause":
        if (this.state !== "playing") return "It is not playing.";
        this.pause("control");
        this.deps.interrupt();
        return "Paused.";
      case "resume":
        return this.resume();
      case "next":
        return this.si + 1 >= total ? "That is the last slide." : this.jump(this.si + 1);
      case "back":
        return this.jump(Math.max(0, this.si - 1));
      case "repeat":
        return this.jump(this.si);
      case "goto":
        if (!slide || slide > total) return `There are only ${total} slides.`;
        return this.jump(slide - 1);
      case "stop":
        this.stopAll();
        return "Stopped.";
    }
  }

  /** For the assistant's next request while it is paused: where it is, and what it may do. */
  contextLine(): string | null {
    if (!this.deck || this.state !== "paused") return null;
    const slide = this.deck.slides[this.si]!;
    const at = Math.min(this.ii, Math.max(0, slide.items.length - 1));
    const said = slide.items[at]?.say;
    return `A presentation of "${this.deck.title}" is paused at slide ${this.si + 1} of ${this.deck.slides.length}, item ${at + 1}${said ? ` ("${clip(said, 80)}")` : ""}. Answer the owner, then use deck.control: resume to go on (it repeats this item), next, back, repeat, goto or stop.`;
  }

  private begin(): void {
    this.state = "playing";
    this.why = null;
    this.run++;
    this.emitView();
    void this.loop(this.run);
  }

  private resume(): string {
    if (this.state !== "paused") return "It is not paused.";
    this.stopCountdown();
    this.shown = this.ii; // the interrupted item comes again from its start
    this.begin();
    return "Going on.";
  }

  private jump(slide: number): string {
    const was = this.state;
    this.releaseWait();
    this.stopCountdown();
    this.run++;
    this.si = slide;
    this.ii = 0;
    this.shown = 0;
    if (was === "playing") this.deps.interrupt();
    this.begin();
    return `Slide ${slide + 1}.`;
  }

  private pause(why: Why): void {
    this.run++;
    this.state = "paused";
    this.why = why;
    this.releaseWait();
    this.emitView();
  }

  private stopAll(): void {
    this.run++;
    this.releaseWait();
    this.stopCountdown();
    this.cancelEnd?.();
    this.cancelEnd = null;
    const wasPlaying = this.state === "playing";
    this.state = "idle";
    this.why = null;
    this.deck = null;
    if (wasPlaying) this.deps.interrupt();
    this.deps.emit({ type: "stage", command: { cmd: "deck", view: null } });
  }

  private stopCountdown(): void {
    this.cancelSilence?.();
    this.cancelSilence = null;
  }

  private releaseWait(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.cancel();
    w?.done();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((done) => {
      const cancel = this.deps.setTimer(() => {
        this.waiting = null;
        done();
      }, ms);
      this.waiting = { cancel, done };
    });
  }

  private emitView(): void {
    this.deps.emit({ type: "stage", command: { cmd: "deck", view: this.view() } });
  }

  private async loop(run: number): Promise<void> {
    const mine = (): boolean => run === this.run && this.deck !== null;
    while (mine()) {
      const slide = this.deck!.slides[this.si]!;
      if (this.ii >= slide.items.length) {
        if (this.si + 1 >= this.deck!.slides.length) return this.finish();
        await this.wait(BEAT_MS);
        if (!mine()) return;
        this.si++;
        this.ii = 0;
        this.shown = 0;
        this.emitView();
        continue;
      }
      const item = slide.items[this.ii]!;
      this.shown = this.ii + 1;
      this.emitView();
      if (this.deps.voiceOn()) await this.deps.speak(item.say).catch(() => {});
      else await this.wait(Math.max(2000, (item.say.trim().split(/\s+/).filter(Boolean).length / 3) * 1000));
      if (!mine()) return;
      this.ii++;
      if (item.hold) {
        await this.wait(item.hold * 1000);
        if (!mine()) return;
      }
    }
  }

  private finish(): void {
    this.state = "ended";
    this.shown = this.deck!.slides[this.si]!.items.length;
    this.emitView();
    this.cancelEnd = this.deps.setTimer(() => {
      this.cancelEnd = null;
      if (this.state !== "ended") return;
      this.state = "idle";
      this.deck = null;
      this.deps.emit({ type: "stage", command: { cmd: "deck", view: null } });
    }, END_MS);
  }
}
