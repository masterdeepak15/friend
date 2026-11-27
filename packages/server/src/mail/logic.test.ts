import type { MailMessage } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { nextWatchState } from "./watchstate";
import { matchRule, renderTemplate, scheduleDue } from "./logic";

const mail = (over: Partial<MailMessage> = {}): MailMessage => ({ id: "1", accountId: 1, providerId: "1-1", threadId: "t", from: { address: "ann@client.com" }, to: [{ address: "support@corp.com" }], cc: [], subject: "Invoice question", date: 1, text: "Where is my invoice 42?", headers: {}, attachments: [], ...over });

describe("templates", () => {
  it("fill {{name}} from the values, in the subject and the text alike", () => {
    expect(renderTemplate({ subject: "Server {{server}} is {{state}}", text: "Hi {{ owner }}, {{server}} went {{state}}." }, { server: "web1", state: "down", owner: "Deepak" })).toEqual({ ok: true, subject: "Server web1 is down", text: "Hi Deepak, web1 went down." });
  });
  it("name every missing value instead of sending a half-filled mail", () => {
    expect(renderTemplate({ subject: "{{a}}", text: "{{b}} {{c}}" }, { a: "x" })).toEqual({ ok: false, missing: ["b", "c"] });
  });
  it("do not run anything that looks like code inside the values", () => {
    const r = renderTemplate({ subject: "s", text: "{{x}}" }, { x: "{{y}} ${process.env}" });
    expect(r).toMatchObject({ ok: true, text: "{{y}} ${process.env}" });
  });
});

describe("mail rules", () => {
  it("match on sender address or whole domain, case ignored", () => {
    expect(matchRule({ from: ["@client.com"] }, mail())).toBe(true);
    expect(matchRule({ from: ["ANN@client.com"] }, mail())).toBe(true);
    expect(matchRule({ from: ["bob@client.com", "@other.com"] }, mail())).toBe(false);
  });
  it("match on the recipient, the subject (words or a pattern) and the text", () => {
    expect(matchRule({ to: ["support@corp.com"] }, mail())).toBe(true);
    expect(matchRule({ subjectContains: "INVOICE" }, mail())).toBe(true);
    expect(matchRule({ subjectRegex: "^invoice\\b" }, mail())).toBe(true);
    expect(matchRule({ bodyContains: "invoice 42" }, mail())).toBe(true);
    expect(matchRule({ bodyContains: "refund" }, mail())).toBe(false);
  });
  it("match on attachments and their type", () => {
    const withPdf = mail({ attachments: [{ name: "a.pdf", type: "application/pdf", size: 1 }] });
    expect(matchRule({ hasAttachment: true }, withPdf)).toBe(true);
    expect(matchRule({ hasAttachment: true }, mail())).toBe(false);
    expect(matchRule({ attachmentType: "pdf" }, withPdf)).toBe(true);
    expect(matchRule({ attachmentType: "image/" }, withPdf)).toBe(false);
  });
  it("need every condition, and a rule with no condition matches nothing (never everything by accident)", () => {
    expect(matchRule({ from: ["@client.com"], subjectContains: "refund" }, mail())).toBe(false);
    expect(matchRule({}, mail())).toBe(false);
  });
  it("never match on a pattern that is broken or that could hang", () => {
    expect(matchRule({ subjectRegex: "(" }, mail())).toBe(false);
    expect(matchRule({ subjectRegex: "(a+)+$" }, mail({ subject: "a".repeat(40) + "!" }))).toBe(false);
  });
});

describe("schedules", () => {
  const at = (h: number, m: number, day = 10) => new Date(2026, 10, day, h, m, 0).getTime();
  it("a daily one fires once after its time and not again that day", () => {
    const s = { kind: "daily" as const, at: "08:00", lastRun: at(9, 0, 9) };
    expect(scheduleDue(s, at(7, 59))).toBe(false);
    expect(scheduleDue(s, at(8, 0))).toBe(true);
    expect(scheduleDue({ ...s, lastRun: at(8, 0) }, at(20, 0))).toBe(false);
    expect(scheduleDue({ ...s, lastRun: at(8, 0) }, at(8, 0, 11))).toBe(true);
  });
  it("a daily one that was missed (the PC was off) fires once when it is back", () => {
    expect(scheduleDue({ kind: "daily", at: "08:00", lastRun: at(8, 0, 9) }, at(13, 30))).toBe(true);
  });
  it("one made after today's time waits for tomorrow", () => {
    expect(scheduleDue({ kind: "daily", at: "08:00", lastRun: at(9, 30) }, at(10, 0))).toBe(false);
  });
  it("an every-N-minutes one fires when the time has passed", () => {
    expect(scheduleDue({ kind: "every", minutes: 30, lastRun: 0 }, 29 * 60_000)).toBe(false);
    expect(scheduleDue({ kind: "every", minutes: 30, lastRun: 0 }, 30 * 60_000)).toBe(true);
  });
  it("a bad time never fires", () => {
    expect(scheduleDue({ kind: "daily", at: "25:99", lastRun: 0 }, at(12, 0))).toBe(false);
  });
});

describe("watch states", () => {
  it("goes down only after two failed checks in a row, and says so once", () => {
    let s = { state: "up" as const, fails: 0 } as ReturnType<typeof nextWatchState>;
    s = nextWatchState(s, false);
    expect(s).toMatchObject({ state: "up", fails: 1, changed: null });
    s = nextWatchState(s, false);
    expect(s).toMatchObject({ state: "down", changed: "down" });
    s = nextWatchState(s, false);
    expect(s).toMatchObject({ state: "down", changed: null });
  });
  it("one failure that clears itself is not an alert", () => {
    let s = nextWatchState({ state: "up", fails: 0 }, false);
    s = nextWatchState(s, true);
    expect(s).toMatchObject({ state: "up", fails: 0, changed: null });
  });
  it("comes back up with a message, and a first good check says nothing", () => {
    expect(nextWatchState({ state: "down", fails: 3 }, true)).toMatchObject({ state: "up", changed: "up" });
    expect(nextWatchState({ state: "unknown", fails: 0 }, true)).toMatchObject({ state: "up", changed: null });
    expect(nextWatchState(nextWatchState({ state: "unknown", fails: 0 }, false), false)).toMatchObject({ state: "down", changed: "down" });
  });
});
