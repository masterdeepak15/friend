import type { ServerMsg } from "@friend/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoicePermission } from "./permission";

const card = (over: Partial<Extract<ServerMsg, { type: "approval.request" }>> = {}): ServerMsg => ({ type: "approval.request", id: "a1", tool: "message.send", summary: "Send a telegram message to me:\nDinner is ready", tier: "T2", needsPin: false, ...over });

let send: ReturnType<typeof vi.fn>;
let answer: ReturnType<typeof vi.fn>;
let base: ReturnType<typeof vi.fn>;
let linked: ("telegram" | "whatsapp")[];
let screen: boolean;
const make = (waitMs = 40) => new VoicePermission({ send: send as never, linked: () => linked, screenOpen: () => screen, waitMs });
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  send = vi.fn(async () => ({ ok: true }));
  answer = vi.fn();
  base = vi.fn();
  linked = ["telegram"];
  screen = false;
});

describe("asking by message", () => {
  it("sends what was asked and the way to answer, to the linked messaging app, and waits", async () => {
    const p = make();
    p.wrapEmit(base as never, answer as never)(card());
    await tick(5);
    expect(send).toHaveBeenCalledTimes(1);
    const [channel, to, text] = send.mock.calls[0]!;
    expect([channel, to]).toEqual(["telegram", "me"]);
    expect(text).toContain("Dinner is ready");
    expect(text).toMatch(/reply YES/i);
    expect(text).toMatch(/2 minutes/);
    expect(answer).not.toHaveBeenCalled();
  });

  it("prefers Telegram, and uses WhatsApp when only that is linked", async () => {
    linked = ["whatsapp", "telegram"];
    make().wrapEmit(base as never, answer as never)(card());
    await tick(5);
    expect(send.mock.calls[0]![0]).toBe("telegram");
    send.mockClear();
    linked = ["whatsapp"];
    make().wrapEmit(base as never, answer as never)(card({ id: "a2" }));
    await tick(5);
    expect(send.mock.calls[0]![0]).toBe("whatsapp");
  });

  it("YES allows the newest waiting request, NO refuses it", async () => {
    const p = make(500);
    const emit = p.wrapEmit(base as never, answer as never);
    emit(card({ id: "first" }));
    emit(card({ id: "second" }));
    expect(p.tryReply("Yes!")).toBe(true);
    expect(answer).toHaveBeenLastCalledWith("second", true);
    expect(p.tryReply("no")).toBe(true);
    expect(answer).toHaveBeenLastCalledWith("first", false);
    expect(p.tryReply("yes")).toBe(false); // nothing is waiting any more
  });

  it("understands Hindi yes and no", async () => {
    const p = make(500);
    p.wrapEmit(base as never, answer as never)(card());
    expect(p.tryReply("हाँ")).toBe(true);
    expect(answer).toHaveBeenLastCalledWith("a1", true);
    p.wrapEmit(base as never, answer as never)(card({ id: "a2" }));
    expect(p.tryReply("नहीं")).toBe(true);
    expect(answer).toHaveBeenLastCalledWith("a2", false);
  });

  it("leaves other messages alone, so they go to the assistant as usual", () => {
    const p = make(500);
    p.wrapEmit(base as never, answer as never)(card());
    expect(p.tryReply("how is my portfolio")).toBe(false);
    expect(p.tryReply("yes please do it and also delete everything")).toBe(false);
    expect(answer).not.toHaveBeenCalled();
  });

  it("refuses when nobody answers in time", async () => {
    make(30).wrapEmit(base as never, answer as never)(card());
    await tick(80);
    expect(answer).toHaveBeenCalledWith("a1", false);
  });
});

describe("when it cannot ask", () => {
  it("refuses at once with no messaging app and no screen, and sends nothing", async () => {
    linked = [];
    make().wrapEmit(base as never, answer as never)(card());
    expect(answer).toHaveBeenCalledWith("a1", false);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses at once when the message cannot be sent and there is no screen", async () => {
    send.mockResolvedValue({ ok: false });
    make().wrapEmit(base as never, answer as never)(card());
    await tick(5);
    expect(answer).toHaveBeenCalledWith("a1", false);
  });

  it("with a screen open and no messaging app, waits for the screen", async () => {
    linked = [];
    screen = true;
    make(500).wrapEmit(base as never, answer as never)(card());
    expect(answer).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledTimes(1); // the card reaches the screen
  });

  it("never lets a request that needs the PIN wait: it is refused at once", async () => {
    make().wrapEmit(base as never, answer as never)(card({ id: "pin", tier: "T3", needsPin: true }));
    expect(answer).toHaveBeenCalledWith("pin", false);
    expect(send).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
  });

  it("passes other messages through untouched", () => {
    const emit = make().wrapEmit(base as never, answer as never);
    const m: ServerMsg = { type: "caption.delta", text: "hello" } as ServerMsg;
    emit(m);
    expect(base).toHaveBeenCalledWith(m);
  });
});
