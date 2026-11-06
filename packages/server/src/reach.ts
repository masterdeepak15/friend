export type OwnerChannel = "telegram" | "whatsapp" | "sms";

export interface PhoneDeps {
  /** The ways to reach the owner's phone that are switched on and linked, in the order to try. */
  channels: OwnerChannel[];
  /** Sends text to the owner's own chat or number. */
  send(channel: OwnerChannel, text: string): Promise<{ ok: boolean }>;
  audit(event: string, detail: Record<string, unknown>): void;
}

export interface DeliverDeps extends PhoneDeps {
  /** Whether a Friend screen is open (the owner is looking at it, or can). */
  screenOpen: boolean;
  /** Puts the words on the screen (they stay there for a while, for when the owner comes back). */
  show(title: string, text: string): void;
}

/** What the assistant tells the owner, as one message to a phone: a title line, then the same words, short enough for a chat. */
export const phoneText = (title: string, text: string): string => `${title}\n\n${text.trim()}`.slice(0, 1500);

/** Sends to the first of Telegram, WhatsApp and SMS that works. Returns which one, or null when none did. */
export async function sendToPhone(d: PhoneDeps, text: string): Promise<OwnerChannel | null> {
  for (const ch of d.channels) {
    try {
      const r = await d.send(ch, text);
      if (r.ok) {
        d.audit("owner.reached", { via: ch });
        return ch;
      }
    } catch {
      // try the next way
    }
  }
  return null;
}

/**
 * Gets something the assistant has to tell the owner to them, whatever it is about (finished work, a reminder, a result they waited for):
 * on the screen when one is open; otherwise the first phone app that works; and when no way reaches them, on the screen anyway so it is
 * there when they come back. Returns where it went.
 */
export async function deliverToOwner(text: string, d: DeliverDeps, title = "Friend"): Promise<"screen" | OwnerChannel | "screen-later" | null> {
  const body = text.trim();
  if (!body) return null;
  if (d.screenOpen) {
    d.show(title, body);
    return "screen";
  }
  const via = await sendToPhone(d, phoneText(title, body));
  if (via) return via;
  d.audit("owner.unreached", { channels: d.channels.length });
  d.show(title, body);
  return "screen-later";
}
