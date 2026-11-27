import type { MailMessage } from "@friend/protocol";
import { isAutomatic } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { hasNewWords, newWords, threadKey } from "./closing";
import { FakeMailProvider } from "./fake";
import { MailService } from "./service";
import { MailStore } from "./store";

describe("what a mail holds that is new", () => {
  it("leaves out the quoted earlier mail and the rule lines under it, in any language", () => {
    expect(newWords("Can you send the invoice?\n\n> On Monday you wrote\n> the earlier text")).toBe("Can you send the invoice?");
    expect(hasNewWords("> only the quoted mail\n> and more of it")).toBe(false);
    expect(hasNewWords("   \n")).toBe(false);
    expect(hasNewWords("ठीक है, धन्यवाद")).toBe(true); // words in another script count as words, with no list of them anywhere
    expect(hasNewWords("👍")).toBe(false);
  });
  it("tells that two subjects are one conversation", () => {
    expect(threadKey("Re: RE: Fwd: Invoice 42")).toBe("invoice 42");
    expect(threadKey("AW: Rechnung")).toBe("rechnung");
  });
});

describe("mail that announces itself as automatic", () => {
  const msg = (headers: Record<string, string>) => ({ from: { address: "ann@x.com" }, headers });
  it("is told by its own marks, not by its words", () => {
    expect(isAutomatic(msg({ "x-autoreply": "yes" }))).toBe(true);
    expect(isAutomatic(msg({ "x-auto-response-suppress": "All" }))).toBe(true);
    expect(isAutomatic(msg({ "return-path": "<>" }))).toBe(true);
    expect(isAutomatic(msg({ "auto-submitted": "auto-replied" }))).toBe(true);
    expect(isAutomatic(msg({}))).toBe(false);
  });
});

function rig(cap?: number) {
  const dir = mkdtempSync(join(tmpdir(), "friend-mailstop-"));
  const db = openDb(dir);
  let now = 1_000_000;
  const store = new MailStore(db, () => now);
  const account = store.createAccount({ name: "Support", address: "support@corp.com", imap: { host: "i", port: 993, tls: true }, smtp: { host: "s", port: 465, secure: true }, username: "u", owners: ["boss@corp.com"], systems: [] });
  const provider = new FakeMailProvider();
  const svc = new MailService({ store, provider: async () => provider, audit: new Audit(db), ...(cap ? { maxRepliesPerThread: () => cap } : {}) });
  const ask = vi.fn(async () => true);
  const keep = (m: Partial<MailMessage>) => store.saveMessage({ id: "", accountId: account.id, providerId: `1-${Math.random()}`, threadId: "t", from: { address: "cust@y.com" }, to: [{ address: "support@corp.com" }], cc: [], subject: "Invoice 42", date: 1, text: "Where is my invoice?", headers: { "message-id": "<q@x>" }, attachments: [], ...m }, "other").id;
  const reply = (id: string, why?: string) => svc.send(account.id, { kind: "reply", to: ["cust@y.com"], subject: "Invoice 42", text: "It went out today.", inReplyToId: id }, { cause: "inbound-other", inboundFrom: "cust@y.com", roleAuto: true, ...(why !== undefined ? { why } : {}) }, ask);
  return { store, account, provider, svc, keep, reply, advance: (ms: number) => (now += ms) };
}

describe("knowing when to stop answering a mailbox", () => {
  it("does not answer for a reason it was not given: the model must say why the mail needs an answer", async () => {
    const r = rig();
    const id = r.keep({});
    expect(await r.reply(id)).toMatchObject({ ok: false, reason: expect.stringMatching(/why/i) });
    expect(await r.reply(id, "")).toMatchObject({ ok: false });
    expect(r.provider.sent).toEqual([]);
    expect(await r.reply(id, "The customer asked where their invoice is")).toMatchObject({ ok: true });
  });

  it("does not answer a mail that holds nothing new (the earlier mail quoted back, or nothing)", async () => {
    const r = rig();
    const quoted = r.keep({ text: "> Where is my invoice?\n> It went out today." });
    expect(await r.reply(quoted, "They wrote back")).toMatchObject({ ok: false, reason: expect.stringMatching(/nothing new/i) });
  });

  it("does not answer mail that marks itself automatic, whatever it says", async () => {
    const r = rig();
    for (const headers of [{ "auto-submitted": "auto-replied" }, { "x-autoreply": "yes" }, { "return-path": "<>" }] as Record<string, string>[]) {
      const id = r.keep({ headers: { "message-id": "<a@x>", ...headers }, text: "Please call me back about the invoice?" });
      expect(await r.reply(id, "Looks like a question")).toMatchObject({ ok: false, reason: expect.stringMatching(/automatic/i) });
    }
  });

  it("answers one conversation only as many times as the setting says in a day, then leaves it to the owner", async () => {
    const r = rig(2);
    const sendOne = async () => {
      const id = r.keep({ text: `Another question ${Math.random()}?` });
      r.advance(10 * 60_000); // not more than three an hour to one person
      return r.reply(id, "A new question");
    };
    expect(await sendOne()).toMatchObject({ ok: true });
    expect(await sendOne()).toMatchObject({ ok: true });
    const third = await sendOne();
    expect(third).toMatchObject({ ok: false, reason: expect.stringMatching(/already answered 2 times/i) });
    r.advance(25 * 3600_000); // the next day it can go on
    expect(await sendOne()).toMatchObject({ ok: true });
  });

  it("counts a conversation by its subject, so another subject from the same person is not stopped", async () => {
    const r = rig(1);
    const a = r.keep({});
    expect(await r.reply(a, "A question")).toMatchObject({ ok: true });
    r.advance(10 * 60_000);
    const b = r.keep({ subject: "Something else", text: "Different matter, can you help?" });
    const res = await r.svc.send(r.account.id, { kind: "reply", to: ["cust@y.com"], subject: "Something else", text: "Yes.", inReplyToId: b }, { cause: "inbound-other", inboundFrom: "cust@y.com", roleAuto: true, why: "They asked for help" }, vi.fn(async () => true));
    expect(res).toMatchObject({ ok: true });
  });
});