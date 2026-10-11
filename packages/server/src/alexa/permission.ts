import type { ServerMsg } from "@friend/protocol";

type Channel = "telegram" | "whatsapp";
type Card = Extract<ServerMsg, { type: "approval.request" }>;

export interface VoicePermissionDeps {
  send(channel: Channel, to: "me", text: string): Promise<{ ok: boolean }>;
  /** The messaging apps that are switched on and linked to the owner. */
  linked(): Channel[];
  /** Whether a Friend screen is open (it shows the same approval card). */
  screenOpen(): boolean;
  /** How long to wait for an answer (default 2 minutes, the same as an approval card on the screen). A function, so the owner's setting applies at once. */
  waitMs?: number | (() => number);
}

const YES = new Set(["yes", "y", "yeah", "ok", "okay", "ha", "haan", "han", "हाँ", "हां", "हा"]);
const NO = new Set(["no", "n", "nope", "nahi", "nahin", "नहीं", "ना"]);
const normal = (t: string): string => t.trim().toLowerCase().replace(/^[\s.!?,।]+|[\s.!?,।]+$/g, "");

interface Waiting {
  id: string;
  answer: (id: string, approve: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * What happens when the assistant, working for a voice from a speaker device, needs the owner's permission. A request that needs
 * the PIN is refused at once (a PIN is never spoken or typed in a chat). Anything else is sent to the owner's Telegram or
 * WhatsApp ("reply YES"), and shown on the screen if one is open. With neither, it is refused.
 */
export class VoicePermission {
  private waiting: Waiting[] = [];

  constructor(private d: VoicePermissionDeps) {}

  wrapEmit(base: (m: ServerMsg) => void, answer: (id: string, approve: boolean) => void): (m: ServerMsg) => void {
    return (m) => {
      if (m.type !== "approval.request") return base(m);
      this.request(m, base, answer);
    };
  }

  private request(card: Card, base: (m: ServerMsg) => void, answer: (id: string, approve: boolean) => void): void {
    const channels = this.d.linked();
    const screen = this.d.screenOpen();
    if (card.needsPin || (!channels.length && !screen)) return answer(card.id, false);

    const waitMs = typeof this.d.waitMs === "function" ? this.d.waitMs() : (this.d.waitMs ?? 120_000);
    const minutes = Math.max(1, Math.round(waitMs / 60_000));
    const entry: Waiting = {
      id: card.id,
      answer,
      timer: setTimeout(() => this.settle(card.id, false), waitMs),
    };
    this.waiting.push(entry);
    if (screen) base(card);
    if (channels.length) {
      const channel = channels.includes("telegram") ? "telegram" : channels[0]!;
      const text = `Alexa asked to: ${card.summary}\nReply YES to allow it, or NO to refuse, within ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
      this.d.send(channel, "me", text).then(
        (r) => {
          if (!r.ok && !screen) this.settle(card.id, false);
        },
        () => {
          if (!screen) this.settle(card.id, false);
        },
      );
    }
  }

  private settle(id: string, approve: boolean): void {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i < 0) return;
    const [entry] = this.waiting.splice(i, 1);
    clearTimeout(entry!.timer);
    entry!.answer(id, approve);
  }

  /** The owner's reply on Telegram or WhatsApp. True when it was a plain yes or no for the newest waiting request. */
  tryReply(text: string): boolean {
    if (!this.waiting.length) return false;
    const t = normal(text);
    const approve = YES.has(t) ? true : NO.has(t) ? false : null;
    if (approve === null) return false;
    this.settle(this.waiting[this.waiting.length - 1]!.id, approve);
    return true;
  }

  /** Whether any request is waiting for a reply. */
  hasWaiting(): boolean {
    return this.waiting.length > 0;
  }
}
