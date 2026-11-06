import type { PendingApproval } from "@friend/protocol";
import type { ApprovalRequest, RemoteAsk } from "./approvals";
import type { PhoneApprovalsConfig } from "./config";

export type PhoneChannel = "telegram" | "whatsapp";

export interface PhoneApprovalsDeps {
  config(): PhoneApprovalsConfig;
  /** Whether a Friend screen is open (it shows the same approval card). */
  screenOpen(): boolean;
  /** The messaging apps that are switched on and linked to the owner. */
  linked(): PhoneChannel[];
  /** Sends the question to the owner's chat. `buttons` asks Telegram for Allow / Deny buttons for that approval id. */
  send(channel: PhoneChannel, text: string, buttons: { id: string } | null): Promise<{ ok: boolean; ref?: number }>;
  /** Rewrites a message sent earlier (Telegram only): the answer replaces the buttons. */
  edit(channel: PhoneChannel, ref: number, text: string): Promise<void>;
  /** Gives the owner's decision to the approvals (never "always": that stays on the screen). */
  respond(id: string, approve: boolean): Promise<void>;
  audit(event: string, detail: Record<string, unknown>): void;
}

interface Entry {
  info: PendingApproval;
  n: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set once the question has gone to the phone. */
  sent: { channel: PhoneChannel; text: string; ref?: number } | null;
  /** Set when the owner answered from the phone, so the screen's own answer is not described as one. */
  byPhone: boolean;
  /** What to write under the question once it is settled, if that happened before the message left. */
  closed: string | null;
}

/** Kept on the screen unless the owner allows it: a picture from the camera, and an Office worker's request (it can be a command). Sending a file to the owner's own chat is not here: it only ever goes to them. */
export const SCREEN_ONLY = new Set(["camera.snap", "office.action"]);

const YES = new Set(["yes", "y", "yeah", "ok", "okay", "allow", "ha", "haan", "han", "हाँ", "हां", "हा"]);
const NO = new Set(["no", "n", "nope", "deny", "nahi", "nahin", "नहीं", "ना"]);
const normal = (t: string): string => t.trim().toLowerCase().replace(/^[\s.!?,।]+|[\s.!?,।]+$/g, "");
const SUMMARY_MAX = 600;
const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ");

/** The data behind a Telegram button: "fa", the approval id, and y or n. Telegram allows 64 bytes; this is 41. */
export const buttonData = (id: string, approve: boolean): string => `fa:${id}:${approve ? "y" : "n"}`;
export const parseButton = (data: string): { id: string; approve: boolean } | null => {
  const m = /^fa:([0-9a-f-]{36}):([yn])$/.exec(data);
  return m ? { id: m[1]!, approve: m[2] === "y" } : null;
};

/**
 * Asks the owner on their phone when an action needs approval and they are not at the screen (or have not answered it for a
 * while). The same approval stays open on the screen; whichever answers first wins. A request that needs the PIN, and camera
 * and Office requests unless the owner allows them, never go to the phone: a PIN is never typed in a chat.
 */
export class PhoneApprovals implements RemoteAsk {
  private entries = new Map<string, Entry>();
  private counter = 0;

  constructor(private d: PhoneApprovalsDeps) {}

  offer(info: PendingApproval, req: ApprovalRequest): void {
    const c = this.d.config();
    if (!c.enabled || info.needsPin || req.needsPin) return;
    if (SCREEN_ONLY.has(info.tool) && !c.allowRisky) return;
    if (!this.pick(c)) return;
    const entry: Entry = { info, n: (this.counter = (this.counter % 99) + 1), timer: null, sent: null, byPhone: false, closed: null };
    this.entries.set(info.id, entry);
    const wait = this.d.screenOpen() ? c.delaySec * 1000 : 0;
    if (wait <= 0) void this.ask(entry);
    else entry.timer = setTimeout(() => void this.ask(entry), wait);
  }

  settled(id: string, decision: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    this.entries.delete(id);
    const allowed = decision === "approve" || decision === "approve_always";
    const label = decision === "timeout" ? "⌛ Nobody answered in time, so it was not done." : e.byPhone ? (allowed ? "✅ Allowed." : "⛔ Refused.") : `Answered on the screen: ${allowed ? "allowed" : "refused"}.`;
    if (e.sent) void this.mark(e, label);
    else e.closed = label;
  }

  /** Whether any question is waiting on the phone. */
  hasWaiting(): boolean {
    return [...this.entries.values()].some((e) => e.sent);
  }

  /**
   * The owner's typed reply on a messaging app. Returns what to answer back, or null when it was not a yes or no for one of our
   * questions (so it goes on to the assistant as usual). A bare YES or NO counts only while exactly one question is waiting;
   * with several, the number is needed ("YES 2").
   */
  reply(text: string): string | null {
    const waiting = [...this.entries.values()].filter((e) => e.sent);
    if (!waiting.length) return null;
    const m = /^([^\d\s]+)\s*#?(\d{1,2})?$/u.exec(normal(text));
    if (!m) return null;
    const word = m[1]!;
    const approve = YES.has(word) ? true : NO.has(word) ? false : null;
    if (approve === null) return null;
    let target: Entry | undefined;
    if (m[2]) {
      target = waiting.find((e) => e.n === Number(m[2]));
      if (!target) return "There is no waiting request with that number.";
    } else if (waiting.length === 1) {
      target = waiting[0];
    } else {
      return `${waiting.length} requests are waiting. Reply with the number, for example ${approve ? "YES" : "NO"} ${waiting[0]!.n}.`;
    }
    void this.answer(target!, approve, "text");
    return approve ? "Allowed." : "Refused.";
  }

  /** A tap on a Telegram button. Returns the short note Telegram shows the owner. */
  button(id: string, approve: boolean): string {
    const e = this.entries.get(id);
    if (!e || !e.sent) return "That request is no longer waiting.";
    void this.answer(e, approve, "button");
    return approve ? "Allowed." : "Refused.";
  }

  private async answer(e: Entry, approve: boolean, how: "text" | "button"): Promise<void> {
    e.byPhone = true;
    this.d.audit("approval.phone", { id: e.info.id, tool: e.info.tool, approve, how, channel: e.sent?.channel });
    try {
      await this.d.respond(e.info.id, approve);
    } catch {
      // the approval was settled in the meantime; nothing to undo
    }
  }

  private pick(c: PhoneApprovalsConfig): PhoneChannel | null {
    const linked = this.d.linked();
    if (c.channel !== "auto") return linked.includes(c.channel) ? c.channel : null;
    return linked.includes("telegram") ? "telegram" : (linked[0] ?? null);
  }

  private async ask(e: Entry): Promise<void> {
    e.timer = null;
    if (!this.entries.has(e.info.id)) return;
    const c = this.d.config();
    const channel = this.pick(c);
    if (!channel) return;
    const buttons = channel === "telegram" && c.buttons;
    const summary = plain(e.info.summary).slice(0, SUMMARY_MAX);
    const how = buttons ? `Tap a button, or reply YES ${e.n} / NO ${e.n}.` : `Reply YES ${e.n} to allow it, or NO ${e.n} to refuse.`;
    const text = `🔐 Friend needs your OK:\n${summary}\n\n${how}`;
    let r: { ok: boolean; ref?: number };
    try {
      r = await this.d.send(channel, text, buttons ? { id: e.info.id } : null);
    } catch {
      r = { ok: false };
    }
    if (!r.ok) {
      this.d.audit("approval.phone_failed", { id: e.info.id, channel });
      return; // the screen's own card is still there
    }
    e.sent = { channel, text, ...(r.ref !== undefined ? { ref: r.ref } : {}) };
    if (e.closed) await this.mark(e, e.closed);
  }

  private async mark(e: Entry, label: string): Promise<void> {
    const s = e.sent;
    if (!s || s.ref === undefined) return;
    try {
      await this.d.edit(s.channel, s.ref, `${s.text.split("\n\n")[0]}\n\n${label}`);
    } catch {
      // the message may be too old to edit; the answer already took effect
    }
  }
}
