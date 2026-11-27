import type { MailMessage } from "@friend/protocol";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { normalizeMail } from "./normalize";
import { MailAuthError, MailNetworkError, type FetchResult, type MailProvider, type OutgoingMail } from "./provider";
import type { MailCursor } from "./types";

/** The part of an IMAP connection that is used. `ImapFlow` fits it; tests give a small fake. */
export interface ImapClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  close?(): void;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  mailbox: false | { uidValidity: bigint | number; uidNext: number; exists: number };
  fetch(range: string, query: { uid?: boolean; source?: boolean }, options?: { uid?: boolean }): AsyncIterable<{ uid: number; source?: Buffer }>;
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false>;
  messageFlagsAdd(range: string, flags: string[], options?: { uid?: boolean }): Promise<boolean>;
  messageMove(range: string, destination: string, options?: { uid?: boolean }): Promise<unknown>;
  list(): Promise<{ path: string; specialUse?: string }[]>;
  idle(): Promise<unknown>;
  on(event: string, fn: (...a: unknown[]) => void): unknown;
}

export interface SmtpTransport {
  sendMail(m: Record<string, unknown>): Promise<{ messageId: string }>;
}

export interface ImapSmtpSettings {
  imap: { host: string; port: number; tls: boolean };
  smtp: { host: string; port: number; secure: boolean };
  username: string;
  password: string;
}

export interface ImapSmtpDeps {
  imap?: () => ImapClient;
  smtp?: () => SmtpTransport;
}

const parseId = (providerId: string): { validity: number; uid: number } | null => {
  const m = /^(\d+)-(\d+)$/.exec(providerId);
  return m ? { validity: Number(m[1]), uid: Number(m[2]) } : null;
};

/** Mail over IMAP (reading) and SMTP (sending) with a login. Errors never carry the password or what the server said. */
export class ImapSmtpProvider implements MailProvider {
  private client: ImapClient | null = null;
  private usable = false;

  constructor(
    private readonly s: ImapSmtpSettings,
    private readonly deps: ImapSmtpDeps = {},
  ) {}

  private makeImap(): ImapClient {
    if (this.deps.imap) return this.deps.imap();
    return new ImapFlow({ host: this.s.imap.host, port: this.s.imap.port, secure: this.s.imap.tls, auth: { user: this.s.username, pass: this.s.password }, logger: false }) as unknown as ImapClient;
  }

  private wrap(e: unknown, host: string): Error {
    if (e instanceof MailAuthError || e instanceof MailNetworkError) return e;
    const x = e as { authenticationFailed?: boolean; code?: string; responseStatus?: string; responseText?: string };
    if (x?.authenticationFailed || x?.code === "EAUTH" || (x?.responseStatus === "NO" && /auth|login|credential|password/i.test(x.responseText ?? ""))) return new MailAuthError(`${host} refused the sign-in. Check the address, the password (an app password for Gmail or Microsoft 365) and that IMAP is allowed.`);
    return new MailNetworkError(`Could not use ${host}${x?.code ? ` (${String(x.code).slice(0, 30)})` : ""}.`);
  }

  async connect(): Promise<void> {
    if (this.client && this.usable) return;
    const c = this.makeImap();
    c.on("close", () => (this.usable = false));
    c.on("error", () => (this.usable = false));
    try {
      await c.connect();
    } catch (e) {
      throw this.wrap(e, this.s.imap.host);
    }
    this.client = c;
    this.usable = true;
  }

  async disconnect(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.usable = false;
    try {
      await c?.logout();
    } catch {
      c?.close?.();
    }
  }

  private async withInbox<T>(fn: (c: ImapClient) => Promise<T>): Promise<T> {
    await this.connect();
    const c = this.client!;
    try {
      const lock = await c.getMailboxLock("INBOX");
      try {
        return await fn(c);
      } finally {
        lock.release();
      }
    } catch (e) {
      this.usable = false;
      throw this.wrap(e, this.s.imap.host);
    }
  }

  private async parse(source: Buffer, uid: number, validity: number): Promise<MailMessage> {
    return normalizeMail(await simpleParser(source), 0, `${validity}-${uid}`);
  }

  async fetchSince(cursor: MailCursor | null, limit: number): Promise<FetchResult> {
    return this.withInbox(async (c) => {
      const mb = c.mailbox;
      if (!mb) throw new MailNetworkError(`Could not open the inbox on ${this.s.imap.host}.`);
      const validity = Number(mb.uidValidity);
      const backfill = !cursor || cursor.uidValidity !== validity;
      const above = backfill ? Math.max(0, mb.uidNext - 1 - limit) : cursor.lastUid;
      const got: { uid: number; source: Buffer }[] = [];
      for await (const m of c.fetch(`${above + 1}:*`, { uid: true, source: true }, { uid: true })) if (m.uid > above && m.source) got.push({ uid: m.uid, source: m.source });
      got.sort((a, b) => a.uid - b.uid);
      const take = got.slice(0, limit);
      const messages: MailMessage[] = [];
      for (const g of take) messages.push(await this.parse(g.source, g.uid, validity));
      const lastUid = backfill ? Math.max(mb.uidNext - 1, take.at(-1)?.uid ?? 0) : (take.at(-1)?.uid ?? cursor!.lastUid);
      return { messages, cursor: { uidValidity: validity, lastUid }, backfill };
    });
  }

  async getMessage(providerId: string): Promise<MailMessage | null> {
    const id = parseId(providerId);
    if (!id) return null;
    return this.withInbox(async (c) => {
      for await (const m of c.fetch(String(id.uid), { uid: true, source: true }, { uid: true })) if (m.uid === id.uid && m.source) return this.parse(m.source, id.uid, id.validity);
      return null;
    });
  }

  async search(query: string, limit: number): Promise<MailMessage[]> {
    return this.withInbox(async (c) => {
      const validity = Number(c.mailbox ? c.mailbox.uidValidity : 0);
      const uids = ((await c.search({ or: [{ from: query }, { subject: query }, { body: query }] }, { uid: true })) || []).slice(-limit);
      const out: MailMessage[] = [];
      if (!uids.length) return out;
      for await (const m of c.fetch(uids.join(","), { uid: true, source: true }, { uid: true })) if (m.source) out.push(await this.parse(m.source, m.uid, validity));
      return out.reverse();
    });
  }

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    const transport = this.deps.smtp ? this.deps.smtp() : (nodemailer.createTransport({ host: this.s.smtp.host, port: this.s.smtp.port, secure: this.s.smtp.secure, auth: { user: this.s.username, pass: this.s.password } }) as unknown as SmtpTransport);
    try {
      const info = await transport.sendMail({
        from: mail.from,
        to: mail.to,
        ...(mail.cc?.length ? { cc: mail.cc } : {}),
        subject: mail.subject,
        text: mail.text,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references?.length ? { references: mail.references } : {}),
        ...(mail.autoSubmitted ? { headers: { "Auto-Submitted": "auto-replied" } } : {}),
      });
      return { messageId: info.messageId };
    } catch (e) {
      throw this.wrap(e, this.s.smtp.host);
    }
  }

  async markRead(providerId: string): Promise<void> {
    const id = parseId(providerId);
    if (!id) return;
    await this.withInbox((c) => c.messageFlagsAdd(String(id.uid), ["\\Seen"], { uid: true }));
  }

  async archive(providerId: string): Promise<void> {
    const id = parseId(providerId);
    if (!id) return;
    await this.withInbox(async (c) => {
      const boxes = await c.list();
      const target = boxes.find((b) => b.specialUse === "\\Archive") ?? boxes.find((b) => b.specialUse === "\\All") ?? boxes.find((b) => /^archive$/i.test(b.path));
      if (!target) throw new MailNetworkError(`${this.s.imap.host} has no archive folder.`);
      await c.messageMove(String(id.uid), target.path, { uid: true });
    });
  }

  onNew(handler: () => void): () => void {
    let stopped = false;
    let c: ImapClient | null = null;
    void (async () => {
      while (!stopped) {
        try {
          c = this.makeImap();
          await c.connect();
          const lock = await c.getMailboxLock("INBOX");
          c.on("exists", () => handler());
          while (!stopped) await c.idle();
          lock.release();
        } catch {
          if (!stopped) await new Promise<void>((r) => setTimeout(r, 30_000).unref());
        } finally {
          try {
            await c?.logout();
          } catch {
            /* already gone */
          }
        }
      }
    })();
    return () => {
      stopped = true;
      c?.close?.();
    };
  }
}
