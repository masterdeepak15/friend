import type { ServerMsg } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraBroker, MAX_CLIP_BYTES } from "./camera";

const JPEG = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n, 2, 3]);
let sent: ServerMsg[];
const emit = (m: ServerMsg) => sent.push(m);
const idOf = () => (sent.find((m) => m.type === "camera.request") as { id: string }).id;

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("CameraBroker with a short clip", () => {
  it("asks for the number of frames and the seconds, and gives them all back", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal, { frames: 3, seconds: 4 });
    expect(sent).toEqual([{ type: "camera.request", id: idOf(), frames: 3, seconds: 4 }]);
    expect(b.deliver(idOf(), JPEG(1))).toBe("ok");
    expect(b.deliver(idOf(), JPEG(2))).toBe("ok");
    expect(b.pendingId()).toBe(idOf()); // still waiting for the last frame
    expect(b.deliver(idOf(), JPEG(3))).toBe("ok");
    const r = await p;
    expect(r).toMatchObject({ ok: true, mime: "image/jpeg", data: JPEG(1).toString("base64") });
    expect((r as { frames: unknown[] }).frames).toEqual([1, 2, 3].map((n) => ({ mime: "image/jpeg", data: JPEG(n).toString("base64") })));
    expect(b.deliver(idOf(), JPEG(4))).toBe("unknown");
  });

  it("a single picture request is unchanged: no extra fields in the message or the answer", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    expect(sent).toEqual([{ type: "camera.request", id: idOf() }]);
    b.deliver(idOf(), JPEG(1));
    expect(await p).toEqual({ ok: true, mime: "image/jpeg", data: JPEG(1).toString("base64") });
  });

  it("refuses a frame that is not a JPEG and keeps waiting", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal, { frames: 2, seconds: 2 });
    expect(b.deliver(idOf(), Buffer.from("<html></html>"))).toBe("invalid");
    expect(b.deliver(idOf(), JPEG(1))).toBe("ok");
    expect(b.deliver(idOf(), JPEG(2))).toBe("ok");
    expect((await p).ok).toBe(true);
  });

  it("refuses a frame that would take the clip over the size limit", () => {
    const b = new CameraBroker();
    void b.request(emit, new AbortController().signal, { frames: 3, seconds: 3 });
    const big = Buffer.concat([JPEG(1), Buffer.alloc(MAX_CLIP_BYTES - 10)]);
    expect(b.deliver(idOf(), big)).toBe("ok");
    expect(b.deliver(idOf(), big)).toBe("invalid");
  });

  it("clamps the frames to 2..12 and the seconds to 1..10", () => {
    const b = new CameraBroker();
    void b.request(emit, new AbortController().signal, { frames: 99, seconds: 99 });
    expect(sent[0]).toMatchObject({ frames: 12, seconds: 10 });
    const c = new CameraBroker();
    sent = [];
    void c.request(emit, new AbortController().signal, { frames: 0, seconds: 0 });
    expect(sent[0]).toMatchObject({ frames: 2, seconds: 1 });
  });

  it("waits the clip's own seconds as well before giving up, and says so in words", async () => {
    const b = new CameraBroker(20_000);
    const p = b.request(emit, new AbortController().signal, { frames: 3, seconds: 10 });
    b.deliver(idOf(), JPEG(1));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(b.pendingId()).toBe(idOf());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await p).toEqual({ ok: false, error: "The camera did not answer in time." });
  });
});
