import type { MailClass, MailMessage } from "@friend/protocol";
import type { Db } from "../db";
import type { OAuthVault } from "../oauth/vault";
import { DEFAULT_LADDER, type Ladder, type MailAccount, type MailCursor, type MailStatus, type SendKind, type StoredMail } from "./types";

const MAX_BODY = 200_000;

interface AccountRow {
  id: number;
  name: string;
  address: string;
  imap_host: string;
  imap_port: number;
  imap_tls: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username: string;
  owners_json: string;
  systems_json: string;
  ladder_json: string;
  enabled: number;
  status: string;
  status_detail: string;
  cursor_json: string;
  created_at: number;
}

interface MessageRow {
  id: number;
  account_id: number;
  provider_id: string;
  thread_id: string;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  subject: string;
  date: number;
  body: string;
  headers_json: string;
  attachments_json: string;
  class: string;
  read: number;
  archived: number;
}

export interface NewAccount {
  name: string;
  address: string;
  imap: MailAccount["imap"];
  smtp: MailAccount["smtp"];
  username: string;
  owners: string[];
  systems: string[];
}

export interface MailEvent {
  id: number;
  accountId: number;
  kind: string;
  providerId: string;
  attempts: number;
}

const parse = <T>(text: string, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

const toAccount = (r: AccountRow): MailAccount => ({
  id: r.id,
  name: r.name,
  address: r.address,
  imap: { host: r.imap_host, port: r.imap_port, tls: !!r.imap_tls },
  smtp: { host: r.smtp_host, port: r.smtp_port, secure: !!r.smtp_secure },
  username: r.username,
  owners: parse<string[]>(r.owners_json, []),
  systems: parse<string[]>(r.systems_json, []),
  ladder: { ...DEFAULT_LADDER, ...parse<Partial<Ladder>>(r.ladder_json, {}) },
  enabled: !!r.enabled,
  status: r.status as MailStatus,
  statusDetail: r.status_detail,
  cursor: parse<MailCursor | null>(r.cursor_json, null),
  createdAt: r.created_at,
});

const toMail = (r: MessageRow): StoredMail => ({
  id: String(r.id),
  accountId: r.account_id,
  providerId: r.provider_id,
  threadId: r.thread_id,
  from: { ...(r.from_name ? { name: r.from_name } : {}), address: r.from_addr },
  to: parse(r.to_json, []),
  cc: parse(r.cc_json, []),
  subject: r.subject,
  date: r.date,
  text: r.body,
  headers: parse(r.headers_json, {}),
  attachments: parse(r.attachments_json, []),
  class: r.class as MailClass,
  read: !!r.read,
  archived: !!r.archived,
});

/** The mailboxes, the mail kept from them, what was done with each arrival and what was sent. No password is ever kept here. */
export class MailStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  createAccount(input: NewAccount): MailAccount {
    if (this.accountByName(input.name)) throw new Error(`There is already a mailbox called ${input.name}.`);
    const id = Number(
      this.db
        .prepare("insert into mail_accounts (name, address, imap_host, imap_port, imap_tls, smtp_host, smtp_port, smtp_secure, username, owners_json, systems_json, ladder_json, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(input.name.trim(), input.address.trim(), input.imap.host, input.imap.port, input.imap.tls ? 1 : 0, input.smtp.host, input.smtp.port, input.smtp.secure ? 1 : 0, input.username, JSON.stringify(input.owners), JSON.stringify(input.systems), JSON.stringify(DEFAULT_LADDER), this.clock()).lastInsertRowid,
    );
    return this.getAccount(id)!;
  }

  getAccount(id: number): MailAccount | null {
    const r = this.db.prepare("select * from mail_accounts where id = ?").get(id) as AccountRow | undefined;
    return r ? toAccount(r) : null;
  }

  accountByName(name: string): MailAccount | null {
    const r = this.db.prepare("select * from mail_accounts where name = ? collate nocase").get(name.trim()) as AccountRow | undefined;
    return r ? toAccount(r) : null;
  }

  listAccounts(): MailAccount[] {
    return (this.db.prepare("select * from mail_accounts order by id").all() as AccountRow[]).map(toAccount);
  }

  updateAccount(id: number, p: Partial<Pick<MailAccount, "name" | "address" | "imap" | "smtp" | "username" | "owners" | "systems" | "ladder" | "enabled" | "status" | "statusDetail" | "cursor">>): void {
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    const add = (col: string, v: string | number) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (p.name !== undefined) add("name", p.name.trim());
    if (p.address !== undefined) add("address", p.address.trim());
    if (p.imap) (add("imap_host", p.imap.host), add("imap_port", p.imap.port), add("imap_tls", p.imap.tls ? 1 : 0));
    if (p.smtp) (add("smtp_host", p.smtp.host), add("smtp_port", p.smtp.port), add("smtp_secure", p.smtp.secure ? 1 : 0));
    if (p.username !== undefined) add("username", p.username);
    if (p.owners) add("owners_json", JSON.stringify(p.owners));
    if (p.systems) add("systems_json", JSON.stringify(p.systems));
    if (p.ladder) add("ladder_json", JSON.stringify(p.ladder));
    if (p.enabled !== undefined) add("enabled", p.enabled ? 1 : 0);
    if (p.status !== undefined) add("status", p.status);
    if (p.statusDetail !== undefined) add("status_detail", p.statusDetail.slice(0, 300));
    if (p.cursor !== undefined) add("cursor_json", p.cursor ? JSON.stringify(p.cursor) : "");
    if (!sets.length) return;
    this.db.prepare(`update mail_accounts set ${sets.join(", ")} where id = ?`).run(...vals, id);
  }

  deleteAccount(id: number): void {
    this.db.prepare("delete from mail_accounts where id = ?").run(id);
  }

  /** Keeps a mail once per provider id. `isNew` is false when it was already there. */
  saveMessage(msg: MailMessage, cls: MailClass): { isNew: boolean; id: string } {
    const had = this.db.prepare("select id from mail_messages where account_id = ? and provider_id = ?").get(msg.accountId, msg.providerId) as { id: number } | undefined;
    if (had) return { isNew: false, id: String(had.id) };
    const id = Number(
      this.db
        .prepare("insert into mail_messages (account_id, provider_id, thread_id, from_addr, from_name, to_json, cc_json, subject, date, body, headers_json, attachments_json, class) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(msg.accountId, msg.providerId, msg.threadId, msg.from.address.toLowerCase(), msg.from.name ?? "", JSON.stringify(msg.to), JSON.stringify(msg.cc), msg.subject.slice(0, 500), msg.date, msg.text.slice(0, MAX_BODY), JSON.stringify(msg.headers), JSON.stringify(msg.attachments), cls).lastInsertRowid,
    );
    return { isNew: true, id: String(id) };
  }

  getMessage(accountId: number, id: string): StoredMail | null {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    const r = this.db.prepare("select * from mail_messages where account_id = ? and id = ?").get(accountId, n) as MessageRow | undefined;
    return r ? toMail(r) : null;
  }

  /** Newest first, not archived. `before` is a message id from an earlier page. */
  recentMessages(accountId: number, limit: number, before?: number): StoredMail[] {
    const rows = this.db.prepare("select * from mail_messages where account_id = ? and archived = 0 and id < ? order by id desc limit ?").all(accountId, before ?? Number.MAX_SAFE_INTEGER, Math.min(Math.max(limit, 1), 200)) as MessageRow[];
    return rows.map(toMail);
  }

  searchMessages(accountId: number, query: string, limit = 20): StoredMail[] {
    const like = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare("select * from mail_messages where account_id = ? and (lower(from_addr) like ? escape '\\' or lower(from_name) like ? escape '\\' or lower(subject) like ? escape '\\' or lower(body) like ? escape '\\') order by id desc limit ?")
      .all(accountId, like, like, like, like, Math.min(Math.max(limit, 1), 100)) as MessageRow[];
    return rows.map(toMail);
  }

  mark(accountId: number, id: string, p: { read?: boolean; archived?: boolean }): void {
    if (p.read !== undefined) this.db.prepare("update mail_messages set read = ? where account_id = ? and id = ?").run(p.read ? 1 : 0, accountId, Number(id));
    if (p.archived !== undefined) this.db.prepare("update mail_messages set archived = ? where account_id = ? and id = ?").run(p.archived ? 1 : 0, accountId, Number(id));
  }

  /** True when this arrival was not known: it is now `pending`. A second claim of the same mail is false whatever became of the first. */
  claimEvent(accountId: number, kind: string, providerId: string): boolean {
    return this.db.prepare("insert or ignore into mail_events (account_id, kind, provider_id, created_at) values (?,?,?,?)").run(accountId, kind, providerId, this.clock()).changes === 1;
  }

  pendingEvents(accountId: number): MailEvent[] {
    const rows = this.db.prepare("select id, account_id, kind, provider_id, attempts from mail_events where account_id = ? and status = 'pending' and next_at <= ? order by id").all(accountId, this.clock()) as { id: number; account_id: number; kind: string; provider_id: string; attempts: number }[];
    return rows.map((r) => ({ id: r.id, accountId: r.account_id, kind: r.kind, providerId: r.provider_id, attempts: r.attempts }));
  }

  finishEvent(id: number): void {
    this.db.prepare("update mail_events set status = 'done', last_error = '' where id = ?").run(id);
  }

  /** One more failed try: tried again after `retryInMs`, or put away as dead when that is null. */
  failEvent(id: number, error: string, retryInMs: number | null): void {
    this.db.prepare("update mail_events set attempts = attempts + 1, last_error = ?, status = ?, next_at = ? where id = ?").run(error.slice(0, 300), retryInMs === null ? "dead" : "pending", retryInMs === null ? 0 : this.clock() + retryInMs, id);
  }

  eventStatus(accountId: number, kind: string, providerId: string): { status: string; attempts: number; lastError: string } | null {
    const r = this.db.prepare("select status, attempts, last_error from mail_events where account_id = ? and kind = ? and provider_id = ?").get(accountId, kind, providerId) as { status: string; attempts: number; last_error: string } | undefined;
    return r ? { status: r.status, attempts: r.attempts, lastError: r.last_error } : null;
  }

  recordSend(accountId: number, s: { to: string[]; subject: string; kind: SendKind; approver: string; result: "sent" | "refused" | "failed" }): void {
    this.db.prepare("insert into mail_sends (account_id, to_json, subject, kind, approver, result, created_at) values (?,?,?,?,?,?,?)").run(accountId, JSON.stringify(s.to.map((a) => a.toLowerCase())), s.subject.slice(0, 300), s.kind, s.approver, s.result, this.clock());
  }

  /** How many mails went out in the last `windowMs`, all of them or to one address. */
  countSends(accountId: number, windowMs: number, to?: string): number {
    const since = this.clock() - windowMs;
    if (!to) return (this.db.prepare("select count(*) as n from mail_sends where account_id = ? and result = 'sent' and created_at > ?").get(accountId, since) as { n: number }).n;
    const like = `%"${to.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
    return (this.db.prepare("select count(*) as n from mail_sends where account_id = ? and result = 'sent' and created_at > ? and to_json like ? escape '\\'").get(accountId, since, like) as { n: number }).n;
  }

  /** An address this mailbox has written to, or heard from. Anyone else is a new recipient and needs an approval. */
  knownRecipient(accountId: number, address: string): boolean {
    const a = address.toLowerCase();
    if (this.db.prepare("select 1 from mail_messages where account_id = ? and from_addr = ? limit 1").get(accountId, a)) return true;
    const like = `%"${a.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
    return !!this.db.prepare("select 1 from mail_sends where account_id = ? and result = 'sent' and to_json like ? escape '\\' limit 1").get(accountId, like);
  }
}

/** The mailbox login, kept sealed in the vault under `mail:<id>`: set once, never read back to a screen, a log or the assistant. */
export class MailSecrets {
  constructor(private readonly vault: OAuthVault) {}
  private key = (id: number) => `mail:${id}`;
  set(id: number, secret: string): void {
    this.vault.patch(this.key(id), { secret });
  }
  get(id: number): string | null {
    return this.vault.get(this.key(id)).secret ?? null;
  }
  clear(id: number): void {
    this.vault.forget(this.key(id));
  }
}
