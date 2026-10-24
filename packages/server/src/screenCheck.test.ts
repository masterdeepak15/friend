import type { ServerMsg } from "@friend/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenCheck } from "./screenCheck";

afterEach(() => vi.useRealTimers());

const setup = (timeoutMs = 1000) => {
  const sent: ServerMsg[] = [];
  const check = new ScreenCheck(timeoutMs);
  const ctl = new AbortController();
  return { sent, check, ctl, emit: (m: ServerMsg) => sent.push(m) };
};

describe("ScreenCheck", () => {
  it("asks the screen and returns what it reports", async () => {
    const { sent, check, ctl, emit } = setup();
    const p = check.request(emit, ctl.signal);
    expect(sent).toHaveLength(1);
    const id = (sent[0] as { id: string }).id;
    expect(sent[0]).toMatchObject({ type: "screen.check" });
    expect(check.reply(id, ["no problems found"])).toBe(true);
    expect(await p).toEqual({ ok: true, lines: ["no problems found"] });
  });

  it("ignores an answer for another request, and a second answer", async () => {
    const { sent, check, ctl, emit } = setup();
    const p = check.request(emit, ctl.signal);
    const id = (sent[0] as { id: string }).id;
    expect(check.reply("other", ["x"])).toBe(false);
    expect(check.reply(id, ["a"])).toBe(true);
    expect(check.reply(id, ["b"])).toBe(false);
    expect(await p).toEqual({ ok: true, lines: ["a"] });
  });

  it("gives up when no screen answers", async () => {
    vi.useFakeTimers();
    const { check, ctl, emit } = setup(500);
    const p = check.request(emit, ctl.signal);
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toMatchObject({ ok: false, error: expect.stringMatching(/did not answer/i) });
  });

  it("serves one at a time", async () => {
    const { check, ctl, emit } = setup();
    void check.request(emit, ctl.signal);
    expect(await check.request(emit, ctl.signal)).toMatchObject({ ok: false, error: expect.stringMatching(/already/i) });
  });

  it("stops when the turn is cancelled, and tells the screen", async () => {
    const { sent, check, ctl, emit } = setup();
    const p = check.request(emit, ctl.signal);
    ctl.abort();
    expect(await p).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/i) });
    expect(sent.map((m) => m.type)).toEqual(["screen.check"]);
  });

  it("answers a waiting tool when everything is cancelled at once", async () => {
    const { check, ctl, emit } = setup();
    const p = check.request(emit, ctl.signal);
    check.cancelAll();
    expect(await p).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/i) });
  });
});
