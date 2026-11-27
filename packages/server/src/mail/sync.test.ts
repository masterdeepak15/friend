import type { MailClass, MailMessage } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { FakeMailProvider } from "./fake";
import { MailAuthError, MailNetworkError } from "./provider";
import { MailStore } from "./store";
import { MailSync } from "./sync";

const OWNER = { "authentication-results": "mx; dkim=pass header.d=corp.com" };

function rig(onMail?: (m: MailMessage, c: MailClass) => Promise<void>) {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-mailsync-")));
  let now = 1_000_000;
  const store = new MailStore(db, () => now);
  const account = store.createAccount({ name: "Support", address: "support@corp.com", imap: { host: "i", port: 993, tls: true }, smtp: { host: "s", port: 465, secure: true }, username: "u", owners: ["boss@corp.com"], systems: [] });
  const provider = new FakeMailProvider();
  const seen: { subject: string; cls: MailClass; id: string }[] = [];
  const handler = onMail ?? (async (m, c) => void seen.push({ subject: m.subject, cls: c, id: m.id }));
  const make = () => new MailSync({ store, open: async () => provider, onMail: handler, audit: new Audit(db) });
  return { db, store, account, provider, seen, sync: make(), make, advance: (ms: number) => (now += ms) };
}

describe("mail arriving", () => {
  it("the first look is kept for reading but starts nothing; later mail is classified and handed on once", async () => {
    const r = rig();
    r.provider.deliver({ from: { address: "old@x.com" }, subject: "old" });
    await r.sync.syncNow(r.account.id);
    expect(r.seen).toEqual([]);
    expect(r.store.recentMessages(r.account.id, 10).map((m) => m.subject)).toEqual(["old"]);
    r.provider.deliver({ from: { address: "boss@corp.com" }, subject: "do it", headers: OWNER });
    r.provider.deliver({ from: { address: "boss@corp.com" }, subject: "forged" });
    r.provider.deliver({ from: { address: "ann@x.com" }, subject: "help" });
    await r.sync.syncNow(r.account.id);
    expect(r.seen.map((s) => [s.subject, s.cls])).toEqual([["do it", "owner"], ["forged", "other"], ["help", "other"]]);
    expect(r.seen[0]!.id).not.toBe(""); // handed on with its stored id
    expect(r.store.getAccount(r.account.id)).toMatchObject({ status: "online", cursor: { lastUid: 4 } });
  });

  it("is handed on once even when two syncs overlap or the cursor is lost", async () => {
    const r = rig();
    await r.sync.syncNow(r.account.id);
    r.provider.deliver({ from: { address: "ann@x.com" }, subject: "one" });
    await Promise.all([r.sync.syncNow(r.account.id), r.sync.syncNow(r.account.id)]);
    expect(r.seen).toHaveLength(1);
    r.store.updateAccount(r.account.id, { cursor: { uidValidity: 1, lastUid: 0 } }); // the sync position was lost
    await r.make().syncNow(r.account.id); // and a fresh process runs it again
    expect(r.seen).toHaveLength(1);
  });

  it("does not replay old mail as new when the server renumbers its mailbox", async () => {
    const r = rig();
    await r.sync.syncNow(r.account.id);
    r.provider.deliver({ from: { address: "ann@x.com" }, subject: "before" });
    await r.sync.syncNow(r.account.id);
    r.provider.uidValidity = 2;
    await r.sync.syncNow(r.account.id);
    expect(r.seen.map((s) => s.subject)).toEqual(["before"]);
    expect(r.store.getAccount(r.account.id)!.cursor!.uidValidity).toBe(2);
  });
});

describe("when handing a mail on fails", () => {
  it("tries again later with growing waits and delivers it once it works", async () => {
    let calls = 0;
    const got: string[] = [];
    const r = rig(async (m) => {
      if (++calls <= 3) throw new Error("agent busy");
      got.push(m.subject);
    });
    await r.sync.syncNow(r.account.id);
    r.provider.deliver({ from: { address: "ann@x.com" }, subject: "retry me" });
    await r.sync.syncNow(r.account.id);
    expect(calls).toBe(1);
    await r.sync.syncNow(r.account.id); // too soon
    expect(calls).toBe(1);
    r.advance(61_000);
    await r.sync.syncNow(r.account.id);
    r.advance(5 * 60_000 + 1000);
    await r.sync.syncNow(r.account.id);
    r.advance(30 * 60_000 + 1000);
    await r.sync.syncNow(r.account.id);
    expect(calls).toBe(4);
    expect(got).toEqual(["retry me"]);
    expect(r.store.eventStatus(r.account.id, "email.received", "1-1")).toMatchObject({ status: "done" });
  });

  it("puts the mail away as dead after five failures and does not try again", async () => {
    let calls = 0;
    const r = rig(async () => {
      calls++;
      throw new Error("always");
    });
    await r.sync.syncNow(r.account.id);
    r.provider.deliver({ from: { address: "ann@x.com" }, subject: "bad" });
    for (let i = 0; i < 8; i++) {
      await r.sync.syncNow(r.account.id);
      r.advance(40 * 60_000);
    }
    expect(calls).toBe(5);
    expect(r.store.eventStatus(r.account.id, "email.received", "1-1")).toMatchObject({ status: "dead", attempts: 5, lastError: "always" });
  });
});

describe("when the mailbox cannot be used", () => {
  it("a refused sign-in marks it needs-sign-in and stops calling the server until the owner fixes it", async () => {
    const r = rig();
    r.provider.failAuth = true;
    await r.sync.syncNow(r.account.id);
    expect(r.store.getAccount(r.account.id)).toMatchObject({ status: "needs-sign-in" });
    const connects = r.provider.connects;
    await r.sync.syncNow(r.account.id);
    expect(r.provider.connects).toBe(connects);
    r.provider.failAuth = false;
    r.store.updateAccount(r.account.id, { status: "new" }); // the owner changed the password
    await r.sync.syncNow(r.account.id);
    expect(r.store.getAccount(r.account.id)!.status).toBe("online");
  });

  it("a network failure shows as error and recovers by itself", async () => {
    const r = rig();
    r.provider.failFetch = new MailNetworkError("Could not use imap.corp.com.");
    await r.sync.syncNow(r.account.id);
    expect(r.store.getAccount(r.account.id)).toMatchObject({ status: "error", statusDetail: "Could not use imap.corp.com." });
    r.provider.failFetch = null;
    await r.sync.syncNow(r.account.id);
    expect(r.store.getAccount(r.account.id)!.status).toBe("online");
  });

  it("a disabled mailbox is left alone", async () => {
    const r = rig();
    r.store.updateAccount(r.account.id, { enabled: false });
    await r.sync.syncNow(r.account.id);
    expect(r.provider.fetches).toBe(0);
  });

  it("an auth error from the provider is not the same as a crash of the handler", () => {
    expect(new MailAuthError("x").kind).toBe("auth");
  });
});
