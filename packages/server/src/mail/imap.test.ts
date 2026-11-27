import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { ImapSmtpProvider, type ImapClient } from "./imap";
import { MailAuthError, MailNetworkError } from "./provider";

const settings = { imap: { host: "imap.corp.com", port: 993, tls: true }, smtp: { host: "127.0.0.1", port: 0, secure: false }, username: "u@corp.com", password: "s3cret-app-pw" };
const raw = (n: number) => Buffer.from(`From: a${n}@x.com\r\nTo: u@corp.com\r\nSubject: mail ${n}\r\nMessage-ID: <${n}@x>\r\n\r\nbody ${n}\r\n`);

/** A mailbox on the other end of an IMAP connection, in memory. */
class FakeImap implements ImapClient {
  mailbox: ImapClient["mailbox"] = false;
  handlers: Record<string, (() => void)[]> = {};
  moved: { uid: string; to: string }[] = [];
  flagged: string[] = [];
  authFails = false;
  constructor(
    public validity: number,
    public uids: number[],
  ) {}
  async connect() {
    if (this.authFails) throw Object.assign(new Error("Invalid credentials AUTHENTICATIONFAILED user u@corp.com pass s3cret-app-pw"), { authenticationFailed: true });
  }
  async logout() {}
  async getMailboxLock() {
    this.mailbox = { uidValidity: this.validity, uidNext: Math.max(0, ...this.uids) + 1, exists: this.uids.length };
    return { release() {} };
  }
  async *fetch(range: string) {
    const [a, b] = range.split(":");
    const from = Number(a);
    const to = b === undefined ? from : b === "*" ? Infinity : Number(b);
    const all = [...this.uids].sort((x, y) => x - y);
    const hit = all.filter((u) => u >= from && u <= to);
    // like a real server, "n:*" always answers with the last message even when n is past it
    for (const u of hit.length || b !== "*" ? hit : all.slice(-1)) yield { uid: u, source: raw(u) };
  }
  async search() {
    return this.uids.slice(-1);
  }
  async messageFlagsAdd(range: string) {
    this.flagged.push(range);
    return true;
  }
  async messageMove(range: string, to: string) {
    this.moved.push({ uid: range, to });
  }
  async list() {
    return [{ path: "INBOX" }, { path: "[Gmail]/All Mail", specialUse: "\\All" }];
  }
  async idle() {
    await new Promise((r) => setTimeout(r, 5));
  }
  on(event: string, fn: () => void) {
    (this.handlers[event] ??= []).push(fn);
  }
  close() {}
}

describe("reading a mailbox over IMAP", () => {
  it("on the first look keeps the latest mail as backfill and remembers where it ended", async () => {
    const p = new ImapSmtpProvider(settings, { imap: () => new FakeImap(7, [1, 2, 3, 4, 5]) });
    const r = await p.fetchSince(null, 3);
    expect(r.backfill).toBe(true);
    expect(r.messages.map((m) => m.subject)).toEqual(["mail 3", "mail 4", "mail 5"]);
    expect(r.cursor).toEqual({ uidValidity: 7, lastUid: 5 });
    expect(r.messages[0]!.providerId).toBe("7-3");
  });

  it("after that returns only mail above the cursor, oldest first, and nothing when there is none", async () => {
    const fake = new FakeImap(7, [1, 2, 3, 4, 5]);
    const p = new ImapSmtpProvider(settings, { imap: () => fake });
    const r = await p.fetchSince({ uidValidity: 7, lastUid: 3 }, 10);
    expect(r).toMatchObject({ backfill: false, cursor: { uidValidity: 7, lastUid: 5 } });
    expect(r.messages.map((m) => m.subject)).toEqual(["mail 4", "mail 5"]);
    const none = await p.fetchSince({ uidValidity: 7, lastUid: 5 }, 10);
    expect(none.messages).toEqual([]);
    expect(none.cursor.lastUid).toBe(5);
  });

  it("takes a limited batch and leaves the rest for the next round", async () => {
    const p = new ImapSmtpProvider(settings, { imap: () => new FakeImap(7, [1, 2, 3, 4, 5]) });
    const r = await p.fetchSince({ uidValidity: 7, lastUid: 0 }, 2);
    expect(r.messages.map((m) => m.subject)).toEqual(["mail 1", "mail 2"]);
    expect(r.cursor.lastUid).toBe(2);
  });

  it("treats a server that renumbered its mail as a fresh look, not as new mail", async () => {
    const p = new ImapSmtpProvider(settings, { imap: () => new FakeImap(9, [1, 2, 3]) });
    const r = await p.fetchSince({ uidValidity: 7, lastUid: 50 }, 10);
    expect(r.backfill).toBe(true);
    expect(r.cursor).toEqual({ uidValidity: 9, lastUid: 3 });
  });

  it("reads one mail by its id, marks it read, and archives it to the archive folder", async () => {
    const fake = new FakeImap(7, [1, 2, 3]);
    const p = new ImapSmtpProvider(settings, { imap: () => fake });
    expect((await p.getMessage("7-2"))?.subject).toBe("mail 2");
    await p.markRead("7-2");
    expect(fake.flagged).toEqual(["2"]);
    await p.archive("7-2");
    expect(fake.moved).toEqual([{ uid: "2", to: "[Gmail]/All Mail" }]);
  });

  it("says the sign-in was refused without the password or what the server said", async () => {
    const fake = new FakeImap(7, [1]);
    fake.authFails = true;
    const p = new ImapSmtpProvider(settings, { imap: () => fake });
    const err = await p.connect().catch((e) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect(err.message).not.toContain("s3cret-app-pw");
    expect(err.message).not.toContain("u@corp.com");
  });

  it("calls the handler when the server says new mail exists", async () => {
    const fake = new FakeImap(7, [1]);
    const p = new ImapSmtpProvider(settings, { imap: () => fake });
    let n = 0;
    const stop = p.onNew(() => n++);
    await new Promise((r) => setTimeout(r, 30));
    fake.handlers.exists?.forEach((f) => f());
    stop();
    expect(n).toBe(1);
  });
});

describe("sending over SMTP", () => {
  let server: SMTPServer | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  const listen = async (accept: (user: string, pass: string) => boolean) => {
    const got: { to: string[]; source: string }[] = [];
    server = new SMTPServer({
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ["STARTTLS"],
      onAuth: (a, _s, cb) => (accept(a.username ?? "", a.password ?? "") ? cb(null, { user: a.username }) : cb(new Error("Invalid login for u@corp.com with s3cret-app-pw"))),
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          got.push({ to: session.envelope.rcptTo.map((t) => t.address), source: Buffer.concat(chunks).toString() });
          cb();
        });
      },
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server.server.address() as { port: number }).port;
    return { got, settings: { ...settings, smtp: { host: "127.0.0.1", port, secure: false } } };
  };

  it("delivers a reply with its thread headers, and says it was written by a robot when it was", async () => {
    const t = await listen((u, p) => u === "u@corp.com" && p === "s3cret-app-pw");
    const p = new ImapSmtpProvider(t.settings);
    const sent = await p.send({ from: "u@corp.com", to: ["ann@x.com"], subject: "Re: hi", text: "Thanks", inReplyTo: "<1@x>", references: ["<1@x>"], autoSubmitted: true });
    expect(sent.messageId).toMatch(/^<.+>$/);
    expect(t.got).toHaveLength(1);
    expect(t.got[0]!.to).toEqual(["ann@x.com"]);
    const parsed = await simpleParser(t.got[0]!.source);
    expect(parsed.headers.get("auto-submitted")).toBe("auto-replied");
    expect(parsed.inReplyTo).toBe("<1@x>");
    expect(parsed.text).toContain("Thanks");
  });

  it("does not mark a mail written by a person as automatic", async () => {
    const t = await listen(() => true);
    await new ImapSmtpProvider(t.settings).send({ from: "u@corp.com", to: ["ann@x.com"], subject: "s", text: "t" });
    expect((await simpleParser(t.got[0]!.source)).headers.get("auto-submitted")).toBeUndefined();
  });

  it("reports a refused login without the password", async () => {
    const t = await listen(() => false);
    const err = await new ImapSmtpProvider(t.settings).send({ from: "u@corp.com", to: ["a@x.com"], subject: "s", text: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(MailAuthError);
    expect(err.message).not.toContain("s3cret-app-pw");
  });

  it("reports a server that cannot be reached as a network error, tried again later", async () => {
    const p = new ImapSmtpProvider({ ...settings, smtp: { host: "127.0.0.1", port: 1, secure: false } });
    expect(await p.send({ from: "u@corp.com", to: ["a@x.com"], subject: "s", text: "t" }).catch((e) => e)).toBeInstanceOf(MailNetworkError);
  });
});
