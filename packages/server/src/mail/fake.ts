import type { MailMessage } from "@friend/protocol";
import { MailAuthError, type FetchResult, type MailProvider, type OutgoingMail } from "./provider";
import type { MailCursor } from "./types";

/** A mailbox in memory for tests: put mail in with `deliver`, read what was sent from `sent`. */
export class FakeMailProvider implements MailProvider {
  inbox: MailMessage[] = [];
  sent: OutgoingMail[] = [];
  read = new Set<string>();
  archived = new Set<string>();
  uidValidity = 1;
  failAuth = false;
  failFetch: Error | null = null;
  connects = 0;
  fetches = 0;
  private uid = 0;
  private handlers = new Set<() => void>();

  deliver(m: Partial<MailMessage> & { from: MailMessage["from"] }): MailMessage {
    const uid = ++this.uid;
    const msg: MailMessage = { id: "", accountId: 0, providerId: `${this.uidValidity}-${uid}`, threadId: `t${uid}`, to: [], cc: [], subject: "", date: Date.now(), text: "", headers: {}, attachments: [], ...m };
    this.inbox.push(msg);
    for (const h of this.handlers) h();
    return msg;
  }

  async connect(): Promise<void> {
    this.connects++;
    if (this.failAuth) throw new MailAuthError("Sign-in refused");
  }
  async disconnect(): Promise<void> {}

  async fetchSince(cursor: MailCursor | null, limit: number): Promise<FetchResult> {
    this.fetches++;
    if (this.failFetch) throw this.failFetch;
    const uidOf = (m: MailMessage) => Number(m.providerId.split("-")[1]);
    const top = this.inbox.length ? Math.max(...this.inbox.map(uidOf)) : 0;
    if (!cursor || cursor.uidValidity !== this.uidValidity) return { messages: this.inbox.slice(-limit), cursor: { uidValidity: this.uidValidity, lastUid: top }, backfill: true };
    const fresh = this.inbox.filter((m) => uidOf(m) > cursor.lastUid).slice(0, limit);
    return { messages: fresh, cursor: { uidValidity: this.uidValidity, lastUid: fresh.length ? uidOf(fresh.at(-1)!) : cursor.lastUid }, backfill: false };
  }

  async getMessage(providerId: string): Promise<MailMessage | null> {
    return this.inbox.find((m) => m.providerId === providerId) ?? null;
  }
  async search(query: string, limit: number): Promise<MailMessage[]> {
    return this.inbox.filter((m) => `${m.subject} ${m.text}`.toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  }
  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    this.sent.push(mail);
    return { messageId: `<sent-${this.sent.length}@fake>` };
  }
  async markRead(providerId: string): Promise<void> {
    this.read.add(providerId);
  }
  async archive(providerId: string): Promise<void> {
    this.archived.add(providerId);
  }
  onNew(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
