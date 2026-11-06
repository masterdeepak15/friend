import type { PendingApproval } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "./approvals";
import { sanitizePhoneApprovals, type PhoneApprovalsConfig } from "./config";
import { buttonData, parseButton, PhoneApprovals, type PhoneChannel } from "./phoneApprovals";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const info = (id: string, over: Partial<PendingApproval> = {}): PendingApproval => ({ id, tool: "shell.run", summary: "Run: git status", tier: "T2", needsPin: false, ...over });
const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ tool: "shell.run", args: {}, tier: "T2", needsPin: false, ...over });

let cfg: PhoneApprovalsConfig;
let screen: boolean;
let linked: PhoneChannel[];
let sent: { channel: PhoneChannel; text: string; buttons: { id: string } | null }[];
let edits: { ref: number; text: string }[];
let responded: { id: string; approve: boolean }[];
let phone: PhoneApprovals;
let auditLog: { event: string; detail: Record<string, unknown> }[];
let hows: string[];

beforeEach(() => {
  vi.useFakeTimers();
  cfg = sanitizePhoneApprovals(undefined);
  screen = false;
  linked = ["telegram"];
  sent = [];
  edits = [];
  responded = [];
  auditLog = [];
  hows = [];
  let ref = 100;
  phone = new PhoneApprovals({
    config: () => cfg,
    screenOpen: () => screen,
    linked: () => linked,
    send: async (channel, text, buttons) => {
      sent.push({ channel, text, buttons });
      return { ok: true, ref: ++ref };
    },
    edit: async (_c, r, text) => void edits.push({ ref: r, text }),
    respond: async (id, approve, how) => void (responded.push({ id, approve }), hows.push(how)),
    audit: (event, detail) => void auditLog.push({ event, detail }),
  });
});
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("when the phone is asked", () => {
  it("asks at once, with buttons, when no screen is open", async () => {
    phone.offer(info(ID1), req());
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "telegram", buttons: { id: ID1 } });
    expect(sent[0]!.text).toContain("Run: git status");
    expect(sent[0]!.text).toContain("YES 1");
  });

  it("waits for the screen first when one is open, and asks if it is not answered", async () => {
    screen = true;
    phone.offer(info(ID1), req());
    await vi.advanceTimersByTimeAsync(19_000);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toHaveLength(1);
  });

  it("never asks if the screen answers first", async () => {
    screen = true;
    phone.offer(info(ID1), req());
    phone.settled(ID1, "approve");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(0);
  });

  it("does not ask for a PIN-protected request, ever", async () => {
    phone.offer(info(ID1, { needsPin: true }), req({ needsPin: true }));
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("keeps the always-ask actions on the screen unless the owner allows them", async () => {
    phone.offer(info(ID1, { tool: "camera.snap" }), req({ tool: "camera.snap" }));
    await flush();
    expect(sent).toHaveLength(0);
    cfg.allowRisky = true;
    phone.offer(info(ID2, { tool: "camera.snap" }), req({ tool: "camera.snap" }));
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("asks on the phone to send a file to the owner's own chat", async () => {
    phone.offer(info(ID1, { tool: "message.send_file" }), req({ tool: "message.send_file" }));
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("is silent when switched off or when no app is linked", async () => {
    cfg.enabled = false;
    phone.offer(info(ID1), req());
    cfg.enabled = true;
    linked = [];
    phone.offer(info(ID2), req());
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("uses the chosen app, and prefers Telegram on auto", async () => {
    linked = ["whatsapp", "telegram"];
    phone.offer(info(ID1), req());
    cfg.channel = "whatsapp";
    phone.offer(info(ID2), req());
    await flush();
    expect(sent.map((s) => s.channel)).toEqual(["telegram", "whatsapp"]);
    expect(sent[1]!.buttons).toBeNull();
    expect(sent[1]!.text).toContain("Reply YES 2");
  });

  it("sends no buttons when they are switched off", async () => {
    cfg.buttons = false;
    phone.offer(info(ID1), req());
    await flush();
    expect(sent[0]!.buttons).toBeNull();
  });
});

describe("answering", () => {
  it("a button tap allows or refuses, once", async () => {
    phone.offer(info(ID1), req());
    await flush();
    expect(phone.button(ID1, true)).toBe("Allowed.");
    await flush();
    expect(responded).toEqual([{ id: ID1, approve: true }]);
    phone.settled(ID1, "approve");
    await flush();
    expect(edits.at(-1)!.text).toContain("✅ Allowed.");
    expect(phone.button(ID1, false)).toMatch(/no longer waiting/);
  });

  it("a button for a request still waiting for the screen, or an unknown one, does nothing", async () => {
    screen = true;
    phone.offer(info(ID1), req());
    expect(phone.button(ID1, true)).toMatch(/no longer waiting/);
    expect(phone.button(ID2, true)).toMatch(/no longer waiting/);
    expect(responded).toEqual([]);
  });

  it("a bare YES answers the only waiting request", async () => {
    phone.offer(info(ID1), req());
    await flush();
    expect(phone.reply("yes")).toBe("Allowed.");
    await flush();
    expect(responded).toEqual([{ id: ID1, approve: true }]);
  });

  it("understands Hindi and punctuation", async () => {
    phone.offer(info(ID1), req());
    await flush();
    expect(phone.reply("नहीं।")).toBe("Refused.");
    await flush();
    expect(responded).toEqual([{ id: ID1, approve: false }]);
  });

  it("with two waiting, a bare YES is not guessed; the number picks one", async () => {
    phone.offer(info(ID1), req());
    phone.offer(info(ID2), req());
    await flush();
    expect(phone.reply("yes")).toMatch(/2 requests are waiting/);
    expect(responded).toEqual([]);
    expect(phone.reply("yes 9")).toMatch(/no waiting request/i);
    expect(phone.reply("NO 2")).toBe("Refused.");
    await flush();
    expect(responded).toEqual([{ id: ID2, approve: false }]);
  });

  it("leaves other messages for the assistant, and everything when nothing waits", async () => {
    expect(phone.reply("yes")).toBeNull();
    phone.offer(info(ID1), req());
    await flush();
    expect(phone.reply("what is the weather")).toBeNull();
    expect(phone.reply("yes please run it and then delete all files")).toBeNull();
  });

  it("says so under the message when the screen answered or time ran out", async () => {
    phone.offer(info(ID1), req());
    phone.offer(info(ID2), req());
    await flush();
    phone.settled(ID1, "deny");
    phone.settled(ID2, "timeout");
    await flush();
    expect(edits.map((e) => e.text)).toEqual([expect.stringContaining("Answered on the screen: refused."), expect.stringContaining("Nobody answered in time")]);
  });

  it("still marks the message when the screen answered while it was being sent", async () => {
    phone.offer(info(ID1), req());
    phone.settled(ID1, "approve");
    await flush();
    expect(sent).toHaveLength(1);
    expect(edits.at(-1)!.text).toContain("Answered on the screen: allowed.");
    expect(phone.button(ID1, false)).toMatch(/no longer waiting/);
  });
});

describe("the button data", () => {
  it("round-trips, fits Telegram's 64 bytes, and refuses anything else", () => {
    expect(buttonData(ID1, true).length).toBeLessThanOrEqual(64);
    expect(parseButton(buttonData(ID1, true))).toEqual({ id: ID1, approve: true });
    expect(parseButton(buttonData(ID1, false))).toEqual({ id: ID1, approve: false });
    expect(parseButton("fa:../../etc:y")).toBeNull();
    expect(parseButton("other")).toBeNull();
  });
});

describe("the settings", () => {
  it("default to on, 20 seconds, buttons on, risky actions off, and clamp bad values", () => {
    expect(sanitizePhoneApprovals(undefined)).toEqual({ enabled: true, channel: "auto", delaySec: 20, buttons: true, allowRisky: false });
    expect(sanitizePhoneApprovals({ delaySec: 9999 }).delaySec).toBe(110);
    expect(sanitizePhoneApprovals({ delaySec: -5 }).delaySec).toBe(0);
    expect(sanitizePhoneApprovals({ channel: "sms" as never }).channel).toBe("auto");
    expect(sanitizePhoneApprovals({ allowRisky: "yes" as never }).allowRisky).toBe(false);
  });
});


describe("what the phone side writes to the audit trail", () => {
  it("says where a question was delivered", async () => {
    phone.offer(info(ID1), req());
    await flush();
    expect(auditLog).toContainEqual({ event: "approval.delivered", detail: { id: ID1, via: "telegram" } });
  });

  it("says when delivery failed, and the answer comes back with how it was given", async () => {
    linked = ["whatsapp"];
    phone.offer(info(ID1), req());
    await flush();
    expect(auditLog.some((a) => a.event === "approval.delivered" && a.detail.via === "whatsapp")).toBe(true);
    phone.reply("yes");
    await flush();
    expect(responded).toEqual([{ id: ID1, approve: true }]);
    expect(hows).toEqual(["text"]);
  });
});
