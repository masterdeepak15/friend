import type { ServerMsg } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CameraBroker } from "./camera";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
let sent: ServerMsg[];
const emit = (m: ServerMsg) => sent.push(m);
const idOf = () => (sent.find((m) => m.type === "camera.request") as { id: string }).id;

beforeEach(() => {
  sent = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("CameraBroker", () => {
  it("asks the browser and resolves with the delivered picture as base64", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    expect(sent).toEqual([{ type: "camera.request", id: idOf() }]);
    expect(b.pendingId()).toBe(idOf());
    expect(b.deliver(idOf(), JPEG)).toBe("ok");
    expect(await p).toEqual({ ok: true, mime: "image/jpeg", data: JPEG.toString("base64") });
    expect(b.pendingId()).toBeNull();
  });

  it("ignores a picture for an unknown id, and a second one for the same request", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    expect(b.deliver("other", JPEG)).toBe("unknown");
    expect(b.deliver(idOf(), JPEG)).toBe("ok");
    expect(b.deliver(idOf(), JPEG)).toBe("unknown");
    await p;
  });

  it("refuses bytes that are not a JPEG and keeps waiting for a good one", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    expect(b.deliver(idOf(), Buffer.from("<html>not a picture</html>"))).toBe("invalid");
    expect(b.deliver(idOf(), Buffer.alloc(0))).toBe("invalid");
    expect(b.pendingId()).toBe(idOf());
    expect(b.deliver(idOf(), JPEG)).toBe("ok");
    expect((await p).ok).toBe(true);
  });

  it("gives up after the time limit and ignores a late picture", async () => {
    const b = new CameraBroker(20_000);
    const p = b.request(emit, new AbortController().signal);
    const id = idOf();
    vi.advanceTimersByTime(20_001);
    expect(await p).toEqual({ ok: false, error: "The camera did not answer in time." });
    expect(b.deliver(id, JPEG)).toBe("unknown");
  });

  it.each([
    ["off", "The owner has the camera switched off."],
    ["no-camera", "No camera was found."],
    ["permission", "Camera permission was denied in the browser."],
    ["busy", "The camera is in use by another app."],
  ])("turns a %s denial into a plain reason", async (reason, error) => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    expect(b.deny(idOf(), reason)).toBe(true);
    expect(await p).toEqual({ ok: false, error });
    expect(b.deny(idOf(), reason)).toBe(false);
  });

  it("describes an unexpected denial reason without trusting it", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    b.deny(idOf(), "<script>alert(1)</script>");
    expect(await p).toEqual({ ok: false, error: "The camera could not be used." });
  });

  it("cancelAll tells the browsers to stop and resolves the waiting tool", async () => {
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal);
    const id = idOf();
    b.cancelAll(emit);
    expect(sent.at(-1)).toEqual({ type: "camera.cancel", id });
    expect(await p).toEqual({ ok: false, error: "The camera request was cancelled." });
    b.cancelAll(emit); // nothing pending: nothing more is sent
    expect(sent.filter((m) => m.type === "camera.cancel")).toHaveLength(1);
  });

  it("is cancelled when the turn is aborted", async () => {
    const b = new CameraBroker();
    const ac = new AbortController();
    const p = b.request(emit, ac.signal);
    ac.abort();
    expect((await p).ok).toBe(false);
    expect(sent.at(-1)).toMatchObject({ type: "camera.cancel" });
    expect(b.pendingId()).toBeNull();
  });

  it("allows only one request at a time", async () => {
    const b = new CameraBroker();
    const first = b.request(emit, new AbortController().signal);
    expect(await b.request(emit, new AbortController().signal)).toEqual({ ok: false, error: "The camera is already in use." });
    b.deliver(idOf(), JPEG);
    await first;
  });
});
