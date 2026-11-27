import { isAutomatic, wrapUntrusted, type MailClass, type MailMessage } from "@friend/protocol";
import type { Audit } from "../audit";
import { MailAuthError, type MailProvider } from "./provider";
import type { MailStore } from "./store";
import type { SendKind } from "./types";

/** Asks the owner (a card on their screen or phone). True when they allow it. */
export type AskOwner = (reason: string, detail: string) => Promise<boolean>;

/** What caused a send: the owner telling the assistant to, the assistant on its own work, or something somebody else wrote. */
export type SendCause = "owner-order" | "owner-chat" | "agent" | "inbound-other";

export interface SendRequest {
  kind: SendKind;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  /** The stored mail a reply or forward is about. */
  inReplyToId?: string;
}

export type SendResult = { ok: true; messageId: string; approver: "owner" | "auto" } | { ok: false; reason: string };

export interface MailServiceDeps {
  store: MailStore;
  provider: (accountId: number) => Promise<MailProvider>;
  audit: Audit;
}

const HOUR = 3600_000;
const PER_MAILBOX_PER_HOUR = 30;
const PER_PERSON_PER_HOUR = 3;

const lower = (a: string) => a.trim().toLowerCase();

/**
 * Everything that decides whether a mail goes out. These rules are code, not a request to the model: whatever an email says, it cannot
 * make the assistant forward mail, write to a third person, answer a robot, or send without the approval the owner set.
 */
export class MailService {
  constructor(private readonly d: MailServiceDeps) {}

  async send(accountId: number, req: SendRequest, ctx: { cause: SendCause; inboundFrom?: string }, ask: AskOwner): Promise<SendResult> {
    const { store, audit } = this.d;
    const account = store.getAccount(accountId);
    if (!account) return { ok: false, reason: "There is no such mailbox." };
    if (!account.enabled) return { ok: false, reason: `The mailbox ${account.name} is switched off.` };
    if (account.status === "needs-sign-in") return { ok: false, reason: `The mailbox ${account.name} needs its sign-in fixed first (${account.statusDetail || "the password was refused"}).` };
    const refuse = (reason: string): SendResult => {
      store.recordSend(accountId, { to: req.to, subject: req.subject, kind: req.kind, approver: "none", result: "refused" });
      audit.log("assistant", "mail.refused", { account: account.name, kind: req.kind, to: req.to.map(lower), reason });
      return { ok: false, reason };
    };

    const to = req.to.map(lower);
    const owners = new Set(account.owners.map(lower));
    if (ctx.cause === "inbound-other") {
      const from = lower(ctx.inboundFrom ?? "");
      if (req.kind === "forward") return refuse("Mail from someone else cannot make me forward anything.");
      if (!from || to.some((t) => t !== from) || (req.cc?.length ?? 0) > 0) return refuse("Mail from someone else can only be answered to that person, nobody else.");
    }

    let original: ReturnType<MailStore["getMessage"]> = null;
    if (req.kind === "reply" || req.kind === "forward") {
      original = req.inReplyToId ? store.getMessage(accountId, req.inReplyToId) : null;
      if (!original) return refuse("I cannot find the mail to answer.");
      if (req.kind === "reply" && isAutomatic(original)) return refuse("That is automatic or bulk mail (a newsletter, a no-reply address or a robot). It is never answered.");
    }

    if (store.countSends(accountId, HOUR) >= PER_MAILBOX_PER_HOUR) return refuse("Too many mails from this mailbox in the last hour.");
    for (const t of to) if (!owners.has(t) && store.countSends(accountId, HOUR, t) >= PER_PERSON_PER_HOUR) return refuse(`Too many mails to ${t} in the last hour.`);

    const known = to.every((t) => owners.has(t) || store.knownRecipient(accountId, t));
    const mustAsk = account.ladder[req.kind] !== "auto" || !known || ctx.cause === "inbound-other";
    let approver: "owner" | "auto" = "auto";
    if (mustAsk) {
      const detail = `From ${account.name} <${account.address}>\nTo: ${to.join(", ")}${req.cc?.length ? `\nCc: ${req.cc.join(", ")}` : ""}\nSubject: ${req.subject}\n\n${req.text.slice(0, 800)}${req.text.length > 800 ? "\n…" : ""}`;
      const kindWord = req.kind === "send" ? "Send an email" : req.kind === "reply" ? "Reply to an email" : "Forward an email";
      if (!(await ask(`${kindWord} from ${account.name}${known ? "" : " to a new address"}`, detail))) return refuse("The owner declined.");
      approver = "owner";
    }

    const messageIdHeader = original?.headers["message-id"];
    const refs = (original?.headers.references ?? "").split(/\s+/).filter(Boolean);
    const subject = req.kind === "reply" && !/^re:/i.test(req.subject) ? `Re: ${req.subject}` : req.kind === "forward" && !/^fwd?:/i.test(req.subject) ? `Fwd: ${req.subject}` : req.subject;
    const text = req.kind === "forward" && original ? `${req.text}\n\n---------- Forwarded message ----------\nFrom: ${original.from.address}\nSubject: ${original.subject}\n\n${original.text}` : req.text;
    try {
      const provider = await this.d.provider(accountId);
      const sent = await provider.send({
        from: account.address,
        to,
        ...(req.cc?.length ? { cc: req.cc.map(lower) } : {}),
        subject,
        text,
        ...(req.kind === "reply" && messageIdHeader ? { inReplyTo: messageIdHeader, references: [...refs, messageIdHeader] } : {}),
        ...(req.kind === "reply" ? { autoSubmitted: true } : {}),
      });
      store.recordSend(accountId, { to, subject, kind: req.kind, approver, result: "sent" });
      audit.log("assistant", "mail.sent", { account: account.name, kind: req.kind, to, subjectLength: subject.length, bodyLength: text.length, approver, cause: ctx.cause });
      return { ok: true, messageId: sent.messageId, approver };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "The mail could not be sent.";
      store.recordSend(accountId, { to, subject, kind: req.kind, approver, result: "failed" });
      if (e instanceof MailAuthError) store.updateAccount(accountId, { status: "needs-sign-in", statusDetail: reason });
      audit.log("assistant", "mail.failed", { account: account.name, kind: req.kind, to, approver });
      return { ok: false, reason };
    }
  }

  /**
   * What the assistant should do with a mail that has just arrived. Only a verified mail from the owner is an order; everything else is
   * kept for reading and starts nothing. Mail from the mailbox itself and automatic mail never start anything either (that is how loops begin).
   */
  inbound(msg: MailMessage, cls: MailClass): { action: "order" | "keep"; text: string } {
    const account = this.d.store.getAccount(msg.accountId);
    const own = !!account && lower(account.address) === lower(msg.from.address);
    if (cls !== "owner" || own || isAutomatic(msg)) return { action: "keep", text: "" };
    return { action: "order", text: wrapUntrusted(msg, cls) };
  }
}
