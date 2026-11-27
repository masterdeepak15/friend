import type { MailMessage } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { OAuthVault } from "../oauth/vault";
import { MailSecrets, MailStore } from "./store";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "friend-mail-"));
  const db = openDb(dir);
  let now = 1_000_000;
  const store = new MailStore(db, () => now);
  return { dir, db, store, advance: (ms: number) => (now += ms) };
}
const input = (name = "Support") => ({ name, address: "support@corp.com", imap: { host: "imap.corp.com", port: 993, tls: true }, smtp: { host: "smtp.corp.com", port: 465, secure: true }, username: "support@corp.com", owners: ["boss@corp.com"], systems: [] as string[] });
const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: "",
  accountId: 1,
  providerId: "uid-1",
  threadId: "t1",
  from: { name: "Ann", address: "ann@x.com" },
  to: [{ address: "support@corp.com" }],
  cc: [],
  subject: "Hi",
  date: 5,
  text: "body of the mail",
  headers: { "message-id": "<a@x>" },
  attachments: [],
  ...over,
});

describe("mailboxes", () => {
  it("are created with safe defaults, found by name ignoring case, changed and deleted", () => {
    const { store } = rig();
    const a = store.createAccount(input());
    expect(a).toMatchObject({ name: "Support", enabled: true, status: "new", ladder: { send: "ask", reply: "ask", forward: "ask" }, owners: ["boss@corp.com"] });
    expect(store.getAccount(a.id)?.address).toBe("support@corp.com");
    expect(store.accountByName("support")?.id).toBe(a.id);
    expect(() => store.createAccount(input("SUPPORT"))).toThrow(/already/i);
    store.updateAccount(a.id, { ladder: { send: "ask", reply: "auto", forward: "ask" }, status: "needs-sign-in", statusDetail: "Wrong password" });
    expect(store.getAccount(a.id)).toMatchObject({ ladder: { reply: "auto" }, status: "needs-sign-in", statusDetail: "Wrong password" });
    store.deleteAccount(a.id);
    expect(store.getAccount(a.id)).toBeNull();
  });

  it("keep a sync cursor", () => {
    const { store } = rig();
    const a = store.createAccount(input());
    expect(store.getAccount(a.id)?.cursor).toBeNull();
    store.updateAccount(a.id, { cursor: { uidValidity: 7, lastUid: 41 } });
    expect(store.getAccount(a.id)?.cursor).toEqual({ uidValidity: 7, lastUid: 41 });
  });
});

describe("stored mail", () => {
  it("is saved once per provider id, listed newest first with paging, and found by search", () => {
    const { store } = rig();
    const a = store.createAccount(input());
    const first = store.saveMessage(mail({ accountId: a.id }), "other");
    expect(first.isNew).toBe(true);
    expect(store.saveMessage(mail({ accountId: a.id }), "other")).toMatchObject({ isNew: false, id: first.id });
    const second = store.saveMessage(mail({ accountId: a.id, providerId: "uid-2", subject: "Invoice 42", from: { address: "bob@y.com" } }), "owner");
    const list = store.recentMessages(a.id, 10);
    expect(list.map((m) => m.subject)).toEqual(["Invoice 42", "Hi"]);
    expect(list[0]).toMatchObject({ id: second.id, class: "owner" });
    expect(store.recentMessages(a.id, 10, Number(second.id)).map((m) => m.subject)).toEqual(["Hi"]);
    expect(store.searchMessages(a.id, "invoice").map((m) => m.subject)).toEqual(["Invoice 42"]);
    expect(store.searchMessages(a.id, "100%")).toEqual([]);
    expect(store.getMessage(a.id, second.id)?.text).toBe("body of the mail");
    expect(store.getMessage(a.id, "9999")).toBeNull();
  });

  it("cuts a very long body and marks read and archived", () => {
    const { store } = rig();
    const a = store.createAccount(input());
    const { id } = store.saveMessage(mail({ accountId: a.id, text: "x".repeat(300_000) }), "other");
    expect(store.getMessage(a.id, id)!.text.length).toBe(200_000);
    store.mark(a.id, id, { read: true, archived: true });
    expect(store.recentMessages(a.id, 10)).toEqual([]);
    expect(store.getMessage(a.id, id)).toMatchObject({ read: true, archived: true });
  });

  it("goes with the mailbox when it is deleted", () => {
    const { store, db } = rig();
    const a = store.createAccount(input());
    store.saveMessage(mail({ accountId: a.id }), "other");
    store.claimEvent(a.id, "email.received", "uid-1");
    store.deleteAccount(a.id);
    expect((db.prepare("select count(*) as n from mail_messages").get() as { n: number }).n).toBe(0);
    expect((db.prepare("select count(*) as n from mail_events").get() as { n: number }).n).toBe(0);
  });
});

describe("events", () => {
  it("are claimed once, retried later, finished or put away as dead", () => {
    const { store, advance } = rig();
    const a = store.createAccount(input());
    expect(store.claimEvent(a.id, "email.received", "uid-1")).toBe(true);
    expect(store.claimEvent(a.id, "email.received", "uid-1")).toBe(false);
    const [ev] = store.pendingEvents(a.id);
    expect(ev).toMatchObject({ providerId: "uid-1", attempts: 0 });
    store.failEvent(ev!.id, "boom", 60_000);
    expect(store.pendingEvents(a.id)).toEqual([]);
    advance(60_001);
    expect(store.pendingEvents(a.id)[0]).toMatchObject({ attempts: 1 });
    store.failEvent(ev!.id, "boom again", null);
    expect(store.pendingEvents(a.id)).toEqual([]);
    expect(store.eventStatus(a.id, "email.received", "uid-1")).toMatchObject({ status: "dead", attempts: 2, lastError: "boom again" });
    expect(store.claimEvent(a.id, "email.received", "uid-1")).toBe(false);
    expect(store.claimEvent(a.id, "email.received", "uid-2")).toBe(true);
    store.finishEvent(store.pendingEvents(a.id)[0]!.id);
    expect(store.eventStatus(a.id, "email.received", "uid-2")?.status).toBe("done");
  });
});

describe("what was sent", () => {
  it("is counted in a window, per recipient, and remembered as known recipients", () => {
    const { store, advance } = rig();
    const a = store.createAccount(input());
    store.saveMessage(mail({ accountId: a.id }), "other");
    store.recordSend(a.id, { to: ["Cust@Y.com"], subject: "Re", kind: "reply", approver: "owner", result: "sent" });
    store.recordSend(a.id, { to: ["other@y.com"], subject: "s", kind: "send", approver: "auto", result: "refused" });
    expect(store.countSends(a.id, 3600_000)).toBe(1);
    expect(store.countSends(a.id, 3600_000, "cust@y.com")).toBe(1);
    expect(store.countSends(a.id, 3600_000, "other@y.com")).toBe(0);
    expect(store.knownRecipient(a.id, "CUST@y.com")).toBe(true);
    expect(store.knownRecipient(a.id, "ann@x.com")).toBe(true); // wrote to us
    expect(store.knownRecipient(a.id, "stranger@z.com")).toBe(false);
    advance(2 * 3600_000);
    expect(store.countSends(a.id, 3600_000)).toBe(0);
  });
});

describe("the mailbox password", () => {
  it("lives only in the vault, and never in what the store returns", () => {
    const { store, dir, db } = rig();
    const a = store.createAccount(input());
    const secrets = new MailSecrets(new OAuthVault(dir));
    expect(secrets.get(a.id)).toBeNull();
    secrets.set(a.id, "hunter2-app-password");
    expect(secrets.get(a.id)).toBe("hunter2-app-password");
    expect(JSON.stringify(store.getAccount(a.id))).not.toContain("hunter2");
    expect(JSON.stringify(db.prepare("select * from mail_accounts").all())).not.toContain("hunter2");
    secrets.clear(a.id);
    expect(secrets.get(a.id)).toBeNull();
  });
});
